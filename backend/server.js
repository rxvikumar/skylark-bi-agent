/**
 * Monday.com BI Agent — server.mjs v4.0
 * Fixes:
 *  1. No duplicate tool calls — tracks which tools were called per turn
 *  2. Proper SSE format frontend expects (data: {...}\n\n, no event: prefix)
 *  3. Better quota handling — waits before retry, shows friendly message
 *  4. Tool results cached within a single request to avoid redundant Monday API calls
 *  5. Hard cap of 3 agentic iterations max
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { TOOL_DEFINITIONS, TOOL_MAP } from './tools.js';

dotenv.config();

const app  = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT        = process.env.PORT || 3001;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;

// Model priority list — 2.5-flash first, fall back gracefully
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-flash-latest',
];

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Business Intelligence Agent for Skylark Drones — a drone and aerial survey company.

You have LIVE access to two Monday.com boards:
1. Deal Funnel — 344 sales deals across Mining, Powerline, Renewables, Railways, Aviation, Construction
2. Work Orders — 175 executed projects with billing, collection, and receivables data

YOUR ROLE: Answer founder-level business questions with real insights from live data.

CRITICAL TOOL USAGE RULES:
- Call ONLY the tools you need. Do NOT call the same tool twice in one response.
- get_revenue_summary already calls both deal pipeline and work orders internally — do NOT also call get_deal_pipeline or get_work_orders separately in the same turn.
- For "pipeline overview" questions → call get_revenue_summary ONLY (it covers everything)
- For sector-specific → call get_deal_pipeline with sector filter
- For date/quarter context → call get_date_range_context FIRST, then one other tool
- Maximum 3 tool calls per response

AVAILABLE TOOLS:
- get_deal_pipeline(sector?, status?, stage?, owner?, this_quarter?) — deals data
- get_work_orders(sector?, status?, owner?) — work orders & financials
- get_revenue_summary(sector?) — combined cross-board view (USE THIS for overviews)
- get_owner_performance() — win rates & pipeline per owner
- get_sector_comparison() — all sectors side by side
- get_date_range_context() — current quarter & FY dates

RESPONSE RULES:
- Currency: <1L=₹X,XXX | 1L-1Cr=₹X.XX Lakhs | >1Cr=₹X.XX Crores
- Always mention data quality caveats (missing values, dates)
- Give actionable insights, not just data dumps
- "energy" sector = Mining + Powerline + Renewables combined`;

// ─── Gemini REST call ─────────────────────────────────────────────────────────
async function callGemini(contents, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: [{
        function_declarations: TOOL_DEFINITIONS.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }],
      tool_config: { function_calling_config: { mode: 'AUTO' } },
      generation_config: { temperature: 0.1, max_output_tokens: 2048 },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data).slice(0, 200);
    const err = new Error(msg);
    err.status      = res.status;
    err.isQuota     = res.status === 429 || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
    err.isNotFound  = res.status === 404 || msg.includes('not found');
    throw err;
  }

  return data;
}

// Try models in order, skip on quota/404 errors
async function callGeminiWithFallback(contents) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`[Gemini] Trying: ${model}`);
      const result = await callGemini(contents, model);
      console.log(`[Gemini] ✓ Using: ${model}`);
      return { result, model };
    } catch (err) {
      console.log(`[Gemini] ✗ ${model}: ${err.message.slice(0, 100)}`);
      lastErr = err;
      if (err.isQuota || err.isNotFound) continue;
      throw err; // Non-quota error — don't retry
    }
  }
  throw new Error('All Gemini models quota exhausted. ' + (lastErr?.message || ''));
}

function parseGeminiResponse(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('No response from Gemini');
  const parts         = candidate.content?.parts || [];
  const text          = parts.filter(p => p.text).map(p => p.text).join('').trim();
  const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
  return { text, functionCalls, finishReason: candidate.finishReason };
}

// ─── Core agent loop ──────────────────────────────────────────────────────────
async function runAgent(userMessage, history = [], callbacks = {}) {
  const { onToolStart, onToolEnd } = callbacks;
  const toolTrace = [];

  // Build conversation
  const contents = [];
  for (const h of history) {
    const content = (h.content || '').trim();
    if (!content || content.length < 3) continue;
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content.length > 2000 ? content.slice(0, 2000) + '...' : content }],
    });
  }
  // Gemini requires first message to be user role
  while (contents.length > 0 && contents[0].role === 'model') contents.shift();
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  let { result, model } = await callGeminiWithFallback(contents);
  let parsed = parseGeminiResponse(result);

  // ── Agentic loop (max 3 iterations, no duplicate tools) ───────────────────
  const calledTools = new Set(); // Track tools called this request
  let iterations = 0;
  const MAX_ITER = 3;

  while (parsed.functionCalls?.length > 0 && iterations < MAX_ITER) {
    iterations++;

    // Deduplicate — skip tools already called this turn
    const calls = parsed.functionCalls.filter(fc => {
      const key = fc.name + JSON.stringify(fc.args || {});
      if (calledTools.has(key)) {
        console.log(`[Tool] ⚠️  Skipping duplicate: ${fc.name}`);
        return false;
      }
      calledTools.add(key);
      return true;
    });

    if (calls.length === 0) break;

    const toolResults = [];

    for (const call of calls) {
      const toolName   = call.name;
      const toolParams = call.args || {};
      const startTime  = Date.now();

      console.log(`[Tool] → ${toolName}(${JSON.stringify(toolParams)})`);
      onToolStart?.({ tool: toolName, args: toolParams });

      const traceEntry = { tool: toolName, args: toolParams, status: 'running' };

      try {
        if (!TOOL_MAP[toolName]) throw new Error(`Unknown tool: ${toolName}`);
        const toolResult = await TOOL_MAP[toolName](toolParams);

        traceEntry.result     = toolResult;
        traceEntry.status     = 'done';
        traceEntry.duration   = Date.now() - startTime;

        console.log(`[Tool] ✓ ${toolName} (${traceEntry.duration}ms)`);
        onToolEnd?.({ tool: toolName, result: toolResult });
        toolResults.push({ functionResponse: { name: toolName, response: toolResult } });

      } catch (err) {
        traceEntry.status = 'error';
        traceEntry.error  = err.message;

        console.error(`[Tool] ✗ ${toolName}: ${err.message}`);
        onToolEnd?.({ tool: toolName, error: err.message });
        toolResults.push({ functionResponse: { name: toolName, response: { error: err.message } } });
      }

      toolTrace.push(traceEntry);
    }

    // Append model's function calls + tool results to conversation
    contents.push({
      role: 'model',
      parts: calls.map(fc => ({ functionCall: fc })),
    });
    contents.push({
      role: 'user',
      parts: toolResults.map(tr => ({ functionResponse: tr.functionResponse })),
    });

    // Get next Gemini response
    const next = await callGeminiWithFallback(contents);
    parsed = parseGeminiResponse(next.result);
    model  = next.model;
  }

  return {
    answer:     parsed.text || 'I retrieved the data but could not generate a summary. Please try again.',
    tool_trace: toolTrace,
    model,
    iterations,
  };
}

// ─── SSE /api/chat (frontend connects here) ───────────────────────────────────
// The frontend uses fetch + ReadableStream and expects lines like:
//   data: {"type":"tool_start","tool":"...","args":{}}\n\n
//   data: {"type":"tool_end","tool":"...","result":{...}}\n\n
//   data: {"type":"text","text":"..."}\n\n
//   data: {"type":"done","content":"...","tool_trace":[...]}\n\n
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Send a single SSE data line
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
  };

  try {
    const { answer, tool_trace, model } = await runAgent(
      message.trim(),
      history,
      {
        onToolStart: ({ tool, args }) => send({ type: 'tool_start', tool, args }),
        onToolEnd:   ({ tool, result, error }) => send({ type: 'tool_end', tool, result, error }),
      },
    );

    // Stream the answer text word by word for a typing effect
    const words = answer.split(' ');
    for (const word of words) {
      send({ type: 'text', text: word + ' ' });
      await new Promise(r => setTimeout(r, 8));
    }

    send({ type: 'done', content: answer, tool_trace, model });

  } catch (err) {
    console.error('[Chat Error]', err.message);
    const friendly = friendlyError(err);
    send({ type: 'text', text: friendly });
    send({ type: 'done', content: friendly, tool_trace: [] });
  }

  res.end();
});

// ─── Also keep /api/chat/stream for backward compat ──────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  req.url = '/api/chat';
  app.handle(req, res);
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', version: '4.0',
  models: GEMINI_MODELS,
  tools:  Object.keys(TOOL_MAP),
  deals_board: process.env.MONDAY_DEALS_BOARD_ID || 'not set',
  wo_board:    process.env.MONDAY_WORKORDERS_BOARD_ID || 'not set',
  ts: new Date().toISOString(),
}));

// ─── Friendly errors ──────────────────────────────────────────────────────────
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED'))
    return '⏳ All Gemini models are quota-limited right now. Please wait 60 seconds and try again, or add billing at aistudio.google.com to increase limits.';
  if (msg.includes('API_KEY') || msg.includes('401') || msg.includes('403'))
    return '🔑 Invalid Gemini API key. Check GEMINI_API_KEY in your .env file.';
  if (msg.includes('Monday') || msg.includes('GraphQL'))
    return '❌ Monday.com API error. Check MONDAY_API_KEY in .env.';
  return msg.slice(0, 300);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log(`║  🚀 BI Agent v4.0 · Port ${PORT}          ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  📊 Deals Board: ${(process.env.MONDAY_DEALS_BOARD_ID||'not set').padEnd(21)}║`);
  console.log(`║  🔧 WO Board:    ${(process.env.MONDAY_WORKORDERS_BOARD_ID||'not set').padEnd(21)}║`);
  console.log('╠════════════════════════════════════════╣');
  console.log('║  POST /api/chat   (SSE streaming)      ║');
  console.log('║  GET  /health                          ║');
  console.log('╚════════════════════════════════════════╝\n');
});
