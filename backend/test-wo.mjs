/**
 * tools.js — Monday.com BI Agent Tools
 * Uses EXACT column IDs from live boards — no title matching needed
 * All tools make LIVE GraphQL calls — zero caching
 */
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const API_URL    = 'https://api.monday.com/v2';
const KEY        = process.env.MONDAY_API_KEY;
const DEALS_BOARD = process.env.MONDAY_DEALS_BOARD_ID;
const WO_BOARD    = process.env.MONDAY_WORKORDERS_BOARD_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mondayQuery(query) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: KEY, 'API-Version': '2024-01' },
        body: JSON.stringify({ query })
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        if (attempt < 4) { await sleep(4000 * attempt); continue; }
        throw new Error('Invalid JSON from Monday API');
      }
      if (data.errors) {
        const e = data.errors[0];
        if (e.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED') {
          const wait = (e.extensions.retry_in_seconds || 20) * 1000 + 2000;
          console.log(`  ⏸️  Rate limited — waiting ${Math.ceil(wait/1000)}s...`);
          await sleep(wait); continue;
        }
        throw new Error(e.message || JSON.stringify(e));
      }
      return data.data;
    } catch(e) {
      if (e.message.includes('Invalid JSON')) throw e;
      if (attempt < 4) { await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
}

// Fetch ALL items with pagination
async function fetchAllItems(boardId) {
  let all = [], cursor = null;
  while (true) {
    const page = cursor
      ? `items_page(limit:100, cursor:"${cursor}")`
      : `items_page(limit:100)`;
    const data = await mondayQuery(`{
      boards(ids:[${boardId}]) {
        ${page} { cursor items { id name column_values { id text } } }
      }
    }`);
    const p = data.boards[0][cursor ? 'items_page' : 'items_page'];
    const pg = data.boards[0].items_page;
    all = all.concat(pg.items);
    cursor = pg.cursor;
    if (!cursor || pg.items.length === 0) break;
    await sleep(300);
  }
  return all;
}

// EXACT column ID maps from check-columns.mjs output
// Deals board — using mm12 columns (latest, with data)
function parseDeal(item) {
  const cv = {};
  for (const c of item.column_values) cv[c.id] = c.text || '';
  return {
    id:          item.id,
    name:        item.name,
    owner:       cv['text_mm12ga48'] || '',
    client:      cv['text_mm12c6bm'] || '',
    status:      cv['text_mm12jk0p'] || cv['project_status'] || '',
    close_date:  cv['date_mm12rj8e'] || '',
    probability: cv['text_mm12p0y']  || '',
    value:       parseFloat(cv['numeric_mm128fvj']) || 0,
    tent_date:   cv['date_mm12rj8e'] || '',
    stage:       cv['text_mm12xkrq'] || '',
    product:     cv['text_mm125vr0'] || '',
    sector:      cv['text_mm123jjh'] || '',
    created:     cv['date_mm123pgj'] || ''
  };
}

// Work Orders board — using mm12 columns (latest, with data)
function parseWO(item) {
  const cv = {};
  for (const c of item.column_values) cv[c.id] = c.text || '';
  return {
    id:             item.id,
    name:           item.name,
    customer:       cv['text_mm1293cw']   || '',
    serial:         cv['text_mm12aqtc']   || '',
    nature:         cv['text_mm12f7zk']   || '',
    last_month:     cv['text_mm12scvr']   || '',
    exec_status:    cv['text_mm12efvh']   || '',
    delivery_date:  cv['date_mm12nhgt']   || '',
    po_date:        cv['date_mm12weas']   || '',
    doc_type:       cv['text_mm12e280']   || '',
    sector:         cv['text_mm124psa']   || '',
    bd_kam:         cv['text_mm12tfv4']   || '',
    amount:         parseFloat(cv['numeric_mm124f5r']) || 0,
    billed:         parseFloat(cv['numeric_mm12w624']) || 0,
    collected:      parseFloat(cv['numeric_mm122m4j']) || 0,
    receivable:     parseFloat(cv['numeric_mm12wr79']) || 0,
    billing_status: cv['text_mm12wr79']   || '',
    wo_status:      cv['text_mm12efvh']   || '',
    invoice_status: cv['text_mm12e280']   || ''
  };
}

function matchSector(itemSector, filter) {
  if (!filter) return true;
  const is = (itemSector || '').toLowerCase();
  const fs = filter.toLowerCase();
  if (fs === 'energy') return ['mining','powerline','renewables'].some(s => is.includes(s));
  return is.includes(fs);
}

function getCurrentQuarter() {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3);
  const starts = [[0,1],[3,1],[6,1],[9,1]];
  const ends   = [[2,31],[5,30],[8,30],[11,31]];
  return {
    label: `Q${q+1} ${y}`,
    start: new Date(y, starts[q][0], starts[q][1]).toISOString().split('T')[0],
    end:   new Date(y, ends[q][0],   ends[q][1]).toISOString().split('T')[0]
  };
}

function inQuarter(dateStr) {
  if (!dateStr) return false;
  const q = getCurrentQuarter();
  return dateStr >= q.start && dateStr <= q.end;
}

function fmtCr(v) { return (v / 1e7).toFixed(2) + ' Cr'; }

// ── TOOL 1: get_deal_pipeline ─────────────────────────────────────────────────
async function get_deal_pipeline({ sector, status, stage, owner, this_quarter } = {}) {
  const items = await fetchAllItems(DEALS_BOARD);
  let deals = items.map(parseDeal);

  deals = deals.filter(d => {
    if (sector       && !matchSector(d.sector, sector))                              return false;
    if (status       && !d.status.toLowerCase().includes(status.toLowerCase()))      return false;
    if (stage        && !d.stage.toLowerCase().includes(stage.toLowerCase()))        return false;
    if (owner        && !d.owner.toLowerCase().includes(owner.toLowerCase()))        return false;
    if (this_quarter && !inQuarter(d.close_date || d.tent_date))                    return false;
    return true;
  });

  const totalValue    = deals.reduce((s, d) => s + d.value, 0);
  const withValue     = deals.filter(d => d.value > 0).length;
  const missingValue  = deals.length - withValue;
  const missingDate   = deals.filter(d => !d.close_date && !d.tent_date).length;

  const byStage = {}, byStatus = {}, byOwner = {}, bySector = {};
  for (const d of deals) {
    const st = d.stage   || 'Unknown'; if (!byStage[st])  byStage[st]  = {count:0,value:0}; byStage[st].count++;  byStage[st].value  += d.value;
    const ss = d.status  || 'Unknown'; if (!byStatus[ss]) byStatus[ss] = {count:0,value:0}; byStatus[ss].count++; byStatus[ss].value += d.value;
    const ow = d.owner   || 'Unknown'; if (!byOwner[ow])  byOwner[ow]  = {count:0,value:0}; byOwner[ow].count++;  byOwner[ow].value  += d.value;
    const sc = d.sector  || 'Unknown'; if (!bySector[sc]) bySector[sc] = {count:0,value:0}; bySector[sc].count++; bySector[sc].value += d.value;
  }

  return {
    total_deals: deals.length,
    total_pipeline_value: totalValue,
    total_pipeline_crores: fmtCr(totalValue),
    deals_with_value: withValue,
    by_stage:  byStage,
    by_status: byStatus,
    by_owner:  byOwner,
    by_sector: bySector,
    filters_applied: { sector, status, stage, owner, this_quarter },
    quarter: this_quarter ? getCurrentQuarter() : null,
    data_quality: `${missingValue} deals missing value, ${missingDate} missing close date`,
    sample_deals: deals.slice(0,5).map(d => ({
      name: d.name, status: d.status, stage: d.stage,
      sector: d.sector, value: `₹${(d.value/100000).toFixed(2)}L`, close: d.close_date
    }))
  };
}

// ── TOOL 2: get_work_orders ───────────────────────────────────────────────────
async function get_work_orders({ sector, status, owner } = {}) {
  const items = await fetchAllItems(WO_BOARD);
  let orders = items.map(parseWO);

  orders = orders.filter(o => {
    if (sector && !matchSector(o.sector, sector))                                   return false;
    if (status && !o.exec_status.toLowerCase().includes(status.toLowerCase()))     return false;
    if (owner  && !o.bd_kam.toLowerCase().includes(owner.toLowerCase()))           return false;
    return true;
  });

  const totalAmt   = orders.reduce((s,o) => s+o.amount, 0);
  const totalBilled= orders.reduce((s,o) => s+o.billed, 0);
  const totalColl  = orders.reduce((s,o) => s+o.collected, 0);
  const totalRecv  = orders.reduce((s,o) => s+o.receivable, 0);
  const collRate   = totalBilled > 0 ? ((totalColl/totalBilled)*100).toFixed(1) : '0';
  const missingAmt = orders.filter(o => o.amount === 0).length;

  const byStatus = {}, bySector = {}, byNature = {};
  for (const o of orders) {
    const es = o.exec_status||'Unknown'; if(!byStatus[es]) byStatus[es]={count:0,amount:0}; byStatus[es].count++; byStatus[es].amount+=o.amount;
    const sc = o.sector||'Unknown';      if(!bySector[sc]) bySector[sc]={count:0,amount:0}; bySector[sc].count++; bySector[sc].amount+=o.amount;
    const nw = o.nature||'Unknown';      if(!byNature[nw]) byNature[nw]={count:0,amount:0}; byNature[nw].count++; byNature[nw].amount+=o.amount;
  }

  return {
    total_work_orders: orders.length,
    total_amount: totalAmt,
    total_amount_crores: fmtCr(totalAmt),
    total_billed: totalBilled,
    total_billed_crores: fmtCr(totalBilled),
    total_collected: totalColl,
    total_collected_crores: fmtCr(totalColl),
    total_receivable: totalRecv,
    total_receivable_crores: fmtCr(totalRecv),
    collection_rate_pct: collRate + '%',
    by_execution_status: byStatus,
    by_sector: bySector,
    by_nature_of_work: byNature,
    missing_amount: missingAmt,
    data_quality: `${missingAmt} work orders missing amount`,
    sample_orders: orders.slice(0,5).map(o => ({
      name: o.name, status: o.exec_status, sector: o.sector,
      nature: o.nature, amount: fmtCr(o.amount)
    }))
  };
}

// ── TOOL 3: get_revenue_summary ───────────────────────────────────────────────
async function get_revenue_summary({ sector } = {}) {
  const [dealItems, woItems] = await Promise.all([fetchAllItems(DEALS_BOARD), fetchAllItems(WO_BOARD)]);
  const deals  = dealItems.map(parseDeal).filter(d => !sector || matchSector(d.sector, sector));
  const orders = woItems.map(parseWO).filter(o => !sector || matchSector(o.sector, sector));

  const won   = deals.filter(d => d.status.toLowerCase().includes('won'));
  const open  = deals.filter(d => d.status.toLowerCase().includes('open'));
  const pipeV = deals.reduce((s,d) => s+d.value, 0);
  const wonV  = won.reduce((s,d) => s+d.value, 0);
  const amt   = orders.reduce((s,o) => s+o.amount, 0);
  const billed= orders.reduce((s,o) => s+o.billed, 0);
  const coll  = orders.reduce((s,o) => s+o.collected, 0);
  const recv  = orders.reduce((s,o) => s+o.receivable, 0);

  return {
    sector_filter: sector || 'All sectors',
    pipeline: {
      total_deals: deals.length, open_deals: open.length, won_deals: won.length,
      win_rate: deals.length > 0 ? ((won.length/deals.length)*100).toFixed(1)+'%' : '0%',
      total_pipeline: fmtCr(pipeV), won_value: fmtCr(wonV)
    },
    execution: {
      total_work_orders: orders.length,
      total_wo_amount: fmtCr(amt), total_billed: fmtCr(billed),
      total_collected: fmtCr(coll), total_receivable: fmtCr(recv),
      collection_rate: billed > 0 ? ((coll/billed)*100).toFixed(1)+'%' : '0%'
    },
    insight: `${won.length} won deals vs ${orders.length} work orders executed`
  };
}

// ── TOOL 4: get_owner_performance ─────────────────────────────────────────────
async function get_owner_performance() {
  const [dealItems, woItems] = await Promise.all([fetchAllItems(DEALS_BOARD), fetchAllItems(WO_BOARD)]);
  const deals  = dealItems.map(parseDeal);
  const orders = woItems.map(parseWO);

  const stats = {};
  for (const d of deals) {
    const o = d.owner || 'Unknown';
    if (!stats[o]) stats[o] = {total:0, won:0, open:0, pipeline:0, won_value:0};
    stats[o].total++;
    stats[o].pipeline += d.value;
    if (d.status.toLowerCase().includes('won'))  { stats[o].won++;  stats[o].won_value += d.value; }
    if (d.status.toLowerCase().includes('open'))   stats[o].open++;
  }

  const woByKam = {};
  for (const o of orders) { const k = o.bd_kam||'Unknown'; woByKam[k] = (woByKam[k]||0)+1; }

  const board = Object.entries(stats).map(([owner, s]) => ({
    owner,
    total_deals: s.total,
    won: s.won,
    open: s.open,
    win_rate: s.total > 0 ? ((s.won/s.total)*100).toFixed(1)+'%' : '0%',
    pipeline: fmtCr(s.pipeline),
    won_value: fmtCr(s.won_value),
    active_work_orders: woByKam[owner] || 0
  })).sort((a,b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

  return {
    total_owners: board.length,
    leaderboard: board,
    top_by_win_rate: board[0] || null,
    top_by_pipeline: [...board].sort((a,b) => parseFloat(b.pipeline) - parseFloat(a.pipeline))[0] || null
  };
}

// ── TOOL 5: get_sector_comparison ─────────────────────────────────────────────
async function get_sector_comparison() {
  const [dealItems, woItems] = await Promise.all([fetchAllItems(DEALS_BOARD), fetchAllItems(WO_BOARD)]);
  const deals  = dealItems.map(parseDeal);
  const orders = woItems.map(parseWO);

  const sectors = {};
  for (const d of deals) {
    const s = d.sector||'Unknown';
    if (!sectors[s]) sectors[s] = {deals:0, won:0, pipeline:0, won_val:0, wos:0, wo_amt:0};
    sectors[s].deals++; sectors[s].pipeline += d.value;
    if (d.status.toLowerCase().includes('won')) { sectors[s].won++; sectors[s].won_val += d.value; }
  }
  for (const o of orders) {
    const s = o.sector||'Unknown';
    if (!sectors[s]) sectors[s] = {deals:0, won:0, pipeline:0, won_val:0, wos:0, wo_amt:0};
    sectors[s].wos++; sectors[s].wo_amt += o.amount;
  }

  const comparison = Object.entries(sectors).map(([sector, s]) => ({
    sector,
    deals: s.deals, won: s.won,
    win_rate: s.deals > 0 ? ((s.won/s.deals)*100).toFixed(1)+'%' : '0%',
    pipeline: fmtCr(s.pipeline),
    won_value: fmtCr(s.won_val),
    work_orders: s.wos,
    wo_amount: fmtCr(s.wo_amt)
  })).sort((a,b) => parseFloat(b.pipeline) - parseFloat(a.pipeline));

  const energy = comparison.filter(s => ['mining','powerline','renewables'].some(e => s.sector.toLowerCase().includes(e)));
  const energyPipeline = energy.reduce((sum,s) => sum + parseFloat(s.pipeline), 0);

  return {
    sector_comparison: comparison,
    top_by_pipeline: comparison[0] || null,
    top_by_win_rate: [...comparison].sort((a,b) => parseFloat(b.win_rate) - parseFloat(a.win_rate))[0] || null,
    energy_combined_pipeline: fmtCr(energyPipeline * 1e7),
    total_sectors: comparison.length
  };
}

// ── TOOL 6: get_date_range_context ────────────────────────────────────────────
async function get_date_range_context() {
  const now = new Date();
  const q   = getCurrentQuarter();
  const fyS = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    today:            now.toISOString().split('T')[0],
    current_quarter:  q.label,
    quarter_start:    q.start,
    quarter_end:      q.end,
    financial_year:   `FY${fyS}-${(fyS+1).toString().slice(2)}`,
    fy_start:         `${fyS}-04-01`,
    fy_end:           `${fyS+1}-03-31`
  };
}

// ── Tool definitions for Gemini function calling ──────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'get_deal_pipeline',
    description: 'Fetch live deal pipeline from Monday.com. Returns deal counts, values by stage/status/sector/owner. Use for pipeline health, sector analysis, deal forecasting.',
    parameters: {
      type: 'object', properties: {
        sector:       { type: 'string', description: 'Filter by sector: Mining, Powerline, Renewables, Railways, Aviation, Construction, DSP, or "energy"' },
        status:       { type: 'string', description: 'Filter: Open, Won, Dead, On Hold' },
        stage:        { type: 'string', description: 'Filter by stage e.g. Negotiations, Feasibility' },
        owner:        { type: 'string', description: 'Filter by owner code e.g. OWNER_001' },
        this_quarter: { type: 'boolean', description: 'Only deals closing this quarter' }
      }
    }
  },
  {
    name: 'get_work_orders',
    description: 'Fetch live work orders from Monday.com. Returns execution status, billing, collections, receivables. Use for revenue, collection efficiency, project status.',
    parameters: {
      type: 'object', properties: {
        sector: { type: 'string', description: 'Filter by sector' },
        status: { type: 'string', description: 'Filter: Completed, Ongoing, Not Started, Executed until current month' },
        owner:  { type: 'string', description: 'Filter by BD KAM code' }
      }
    }
  },
  {
    name: 'get_revenue_summary',
    description: 'Cross-board revenue: pipeline + actual revenue + win rate + collection rate. Best for overall financial health.',
    parameters: {
      type: 'object', properties: {
        sector: { type: 'string', description: 'Optional sector filter' }
      }
    }
  },
  {
    name: 'get_owner_performance',
    description: 'Leaderboard of owners by win rate, pipeline value, won deals, active work orders.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_sector_comparison',
    description: 'Side-by-side sector comparison: pipeline, win rate, work orders, revenue. Includes energy sector aggregation.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_date_range_context',
    description: 'Returns today, current quarter dates, financial year. Call first for any time-related query.',
    parameters: { type: 'object', properties: {} }
  }
];

export const TOOL_MAP = {
  get_deal_pipeline, get_work_orders, get_revenue_summary,
  get_owner_performance, get_sector_comparison, get_date_range_context
};
