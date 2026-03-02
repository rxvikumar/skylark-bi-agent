import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const API_URL     = 'https://api.monday.com/v2';
const KEY         = process.env.MONDAY_API_KEY;
const DEALS_BOARD = process.env.MONDAY_DEALS_BOARD_ID;
const WO_BOARD    = process.env.MONDAY_WORKORDERS_BOARD_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(query) {
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: KEY, 'API-Version': '2024-01' },
        body: JSON.stringify({ query })
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        if (i < 5) { await sleep(3000 * i); continue; }
        throw new Error('Invalid JSON from Monday API');
      }
      if (data.errors) {
        const e = data.errors[0];
        if (e.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED') {
          await sleep(((e.extensions.retry_in_seconds || 20) + 2) * 1000);
          continue;
        }
        throw new Error(e.message || JSON.stringify(e));
      }
      return data.data;
    } catch(e) {
      if (e.message?.includes('Invalid JSON')) throw e;
      if (i < 5) { await sleep(3000 * i); continue; }
      throw e;
    }
  }
}

// Get column id->title map for a board
async function getColMap(boardId) {
  const data = await gql(`{ boards(ids:[${boardId}]) { columns { id title } } }`);
  const map = {};
  for (const col of data.boards[0].columns) map[col.id] = col.title;
  return map;
}

// Fetch all items from a board, return flat array of plain objects {name, ...columnTitles}
async function fetchBoard(boardId) {
  const colMap = await getColMap(boardId);
  let all = [], cursor = null;
  while (true) {
    const arg = cursor ? `limit:100,cursor:"${cursor}"` : `limit:100`;
    const data = await gql(`{
      boards(ids:[${boardId}]) {
        items_page(${arg}) {
          cursor
          items { id name column_values { id text value } }
        }
      }
    }`);
    const pg = data.boards[0].items_page;
    for (const item of pg.items) {
      const obj = { _id: item.id, name: item.name };
      for (const cv of item.column_values) {
        const title = colMap[cv.id] || cv.id;
        if (cv.text && cv.text.trim()) {
          obj[title] = cv.text.trim();
        } else if (cv.value) {
          try {
            const v = JSON.parse(cv.value);
            if (v && v.number != null) obj[title] = String(v.number);
          } catch(e) {}
        }
      }
      all.push(obj);
    }
    cursor = pg.cursor;
    if (!cursor || pg.items.length === 0) break;
    await sleep(300);
  }
  return all;
}

function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function fmtINR(v) {
  if (!v || v === 0) return '₹0';
  if (v >= 1e7) return `₹${(v/1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v/1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

function matchSector(itemSector, filter) {
  if (!filter) return true;
  const is = (itemSector || '').toLowerCase();
  const fs = filter.toLowerCase();
  if (fs === 'energy') return ['mining','powerline','renewables'].some(s => is.includes(s));
  return is.includes(fs);
}

function getQuarter() {
  const now = new Date(), y = now.getFullYear(), q = Math.floor(now.getMonth()/3);
  const qs = [[0,1],[3,1],[6,1],[9,1]], qe = [[2,31],[5,30],[8,30],[11,31]];
  return {
    label: `Q${q+1} ${y}`,
    start: new Date(y,qs[q][0],qs[q][1]).toISOString().split('T')[0],
    end:   new Date(y,qe[q][0],qe[q][1]).toISOString().split('T')[0]
  };
}

// ── TOOL 1 ────────────────────────────────────────────────────────────────────
async function get_deal_pipeline({ sector, status, stage, owner, this_quarter } = {}) {
  const rows = await fetchBoard(DEALS_BOARD);
  const q = getQuarter();

  let deals = rows.filter(d => {
    if (sector && !matchSector(d['Sector'], sector)) return false;
    if (status && !(d['Deal Status']||'').toLowerCase().includes(status.toLowerCase())) return false;
    if (stage  && !(d['Deal Stage']||'').toLowerCase().includes(stage.toLowerCase()))  return false;
    if (owner  && !(d['Owner Code']||'').toLowerCase().includes(owner.toLowerCase()))  return false;
    if (this_quarter) {
      const cd = d['Close Date'] || d['Tentative Close Date'] || '';
      if (!cd || cd < q.start || cd > q.end) return false;
    }
    return true;
  });

  const totalVal   = deals.reduce((s,d) => s + safeNum(d['Deal Value']), 0);
  const withVal    = deals.filter(d => safeNum(d['Deal Value']) > 0).length;
  const noDate     = deals.filter(d => !d['Close Date'] && !d['Tentative Close Date']).length;

  const tally = (arr, key, valKey) => {
    const out = {};
    for (const d of arr) {
      const k = d[key] || 'Unknown';
      if (!out[k]) out[k] = { count:0, value:0 };
      out[k].count++;
      out[k].value += safeNum(d[valKey]);
    }
    return out;
  };

  return {
    total_deals:          deals.length,
    total_pipeline_value: fmtINR(totalVal),
    deals_with_value:     withVal,
    missing_value:        deals.length - withVal,
    missing_close_date:   noDate,
    by_stage:    tally(deals, 'Deal Stage',  'Deal Value'),
    by_status:   tally(deals, 'Deal Status', 'Deal Value'),
    by_owner:    tally(deals, 'Owner Code',  'Deal Value'),
    by_sector:   tally(deals, 'Sector',      'Deal Value'),
    quarter: this_quarter ? q : null,
    data_quality: `${deals.length - withVal} deals missing value, ${noDate} missing close date`,
    sample_deals: deals.slice(0,5).map(d => ({
      name: d.name, status: d['Deal Status'], stage: d['Deal Stage'],
      sector: d['Sector'], value: fmtINR(safeNum(d['Deal Value'])),
      close: d['Close Date'] || d['Tentative Close Date'] || 'N/A'
    }))
  };
}

// ── TOOL 2 ────────────────────────────────────────────────────────────────────
async function get_work_orders({ sector, status, owner } = {}) {
  const rows = await fetchBoard(WO_BOARD);

  let orders = rows.filter(o => {
    if (sector && !matchSector(o['Sector'], sector)) return false;
    if (status && !(o['Execution Status']||'').toLowerCase().includes(status.toLowerCase())) return false;
    if (owner  && !(o['BD KAM Code']||'').toLowerCase().includes(owner.toLowerCase())) return false;
    return true;
  });

  const amt    = orders.reduce((s,o) => s + safeNum(o['Amount Excl GST']), 0);
  const billed = orders.reduce((s,o) => s + safeNum(o['Billed Value']), 0);
  const coll   = orders.reduce((s,o) => s + safeNum(o['Collected Amount']), 0);
  const recv   = orders.reduce((s,o) => s + safeNum(o['Amount Receivable']), 0);

  const tally = (arr, key, valKey) => {
    const out = {};
    for (const o of arr) {
      const k = o[key] || 'Unknown';
      if (!out[k]) out[k] = { count:0, amount:0 };
      out[k].count++;
      out[k].amount += safeNum(o[valKey]);
    }
    return out;
  };

  return {
    total_work_orders:  orders.length,
    total_amount:       fmtINR(amt),
    total_billed:       fmtINR(billed),
    total_collected:    fmtINR(coll),
    total_receivable:   fmtINR(recv),
    collection_rate:    billed > 0 ? ((coll/billed)*100).toFixed(1)+'%' : '0%',
    by_execution_status: tally(orders, 'Execution Status', 'Amount Excl GST'),
    by_sector:           tally(orders, 'Sector',           'Amount Excl GST'),
    by_nature:           tally(orders, 'Nature of Work',   'Amount Excl GST'),
    missing_amount:      orders.filter(o => !safeNum(o['Amount Excl GST'])).length,
    sample_orders: orders.slice(0,5).map(o => ({
      name: o.name, status: o['Execution Status'], sector: o['Sector'],
      nature: o['Nature of Work'], amount: fmtINR(safeNum(o['Amount Excl GST']))
    }))
  };
}

// ── TOOL 3 ────────────────────────────────────────────────────────────────────
async function get_revenue_summary({ sector } = {}) {
  const [deals, orders] = await Promise.all([fetchBoard(DEALS_BOARD), fetchBoard(WO_BOARD)]);
  const fd = deals.filter(d => !sector || matchSector(d['Sector'], sector));
  const fo = orders.filter(o => !sector || matchSector(o['Sector'], sector));

  const won  = fd.filter(d => (d['Deal Status']||'').toLowerCase().includes('won'));
  const open = fd.filter(d => (d['Deal Status']||'').toLowerCase().includes('open'));
  const pipeV = fd.reduce((s,d) => s + safeNum(d['Deal Value']), 0);
  const wonV  = won.reduce((s,d) => s + safeNum(d['Deal Value']), 0);
  const amt   = fo.reduce((s,o) => s + safeNum(o['Amount Excl GST']), 0);
  const bill  = fo.reduce((s,o) => s + safeNum(o['Billed Value']), 0);
  const coll  = fo.reduce((s,o) => s + safeNum(o['Collected Amount']), 0);
  const recv  = fo.reduce((s,o) => s + safeNum(o['Amount Receivable']), 0);

  return {
    sector_filter: sector || 'All sectors',
    pipeline: {
      total_deals: fd.length, open: open.length, won: won.length,
      win_rate: fd.length > 0 ? ((won.length/fd.length)*100).toFixed(1)+'%' : '0%',
      total_pipeline: fmtINR(pipeV), won_value: fmtINR(wonV)
    },
    execution: {
      total_work_orders: fo.length,
      total_amount: fmtINR(amt), billed: fmtINR(bill),
      collected: fmtINR(coll), receivable: fmtINR(recv),
      collection_rate: bill > 0 ? ((coll/bill)*100).toFixed(1)+'%' : '0%'
    }
  };
}

// ── TOOL 4 ────────────────────────────────────────────────────────────────────
async function get_owner_performance() {
  const [deals, orders] = await Promise.all([fetchBoard(DEALS_BOARD), fetchBoard(WO_BOARD)]);
  const stats = {};
  for (const d of deals) {
    const o = d['Owner Code'] || 'Unknown';
    if (!stats[o]) stats[o] = { total:0, won:0, open:0, pipeline:0, won_val:0 };
    stats[o].total++;
    stats[o].pipeline += safeNum(d['Deal Value']);
    if ((d['Deal Status']||'').toLowerCase().includes('won'))  { stats[o].won++;  stats[o].won_val += safeNum(d['Deal Value']); }
    if ((d['Deal Status']||'').toLowerCase().includes('open'))   stats[o].open++;
  }
  const woKam = {};
  for (const o of orders) { const k = o['BD KAM Code']||'Unknown'; woKam[k] = (woKam[k]||0)+1; }

  const board = Object.entries(stats).map(([owner, s]) => ({
    owner, total: s.total, won: s.won, open: s.open,
    win_rate: s.total > 0 ? ((s.won/s.total)*100).toFixed(1)+'%' : '0%',
    pipeline: fmtINR(s.pipeline), won_value: fmtINR(s.won_val),
    work_orders: woKam[owner] || 0
  })).sort((a,b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

  return { total_owners: board.length, leaderboard: board };
}

// ── TOOL 5 ────────────────────────────────────────────────────────────────────
async function get_sector_comparison() {
  const [deals, orders] = await Promise.all([fetchBoard(DEALS_BOARD), fetchBoard(WO_BOARD)]);
  const s = {};
  for (const d of deals) {
    const k = d['Sector']||'Unknown';
    if (!s[k]) s[k] = {deals:0,won:0,pipe:0,won_val:0,wos:0,wo_amt:0};
    s[k].deals++; s[k].pipe += safeNum(d['Deal Value']);
    if ((d['Deal Status']||'').toLowerCase().includes('won')) { s[k].won++; s[k].won_val += safeNum(d['Deal Value']); }
  }
  for (const o of orders) {
    const k = o['Sector']||'Unknown';
    if (!s[k]) s[k] = {deals:0,won:0,pipe:0,won_val:0,wos:0,wo_amt:0};
    s[k].wos++; s[k].wo_amt += safeNum(o['Amount Excl GST']);
  }
  const cmp = Object.entries(s).map(([sector,v]) => ({
    sector, deals: v.deals, won: v.won,
    win_rate: v.deals > 0 ? ((v.won/v.deals)*100).toFixed(1)+'%' : '0%',
    pipeline: fmtINR(v.pipe), won_value: fmtINR(v.won_val),
    work_orders: v.wos, wo_amount: fmtINR(v.wo_amt)
  })).sort((a,b) => parseFloat(b.pipeline) - parseFloat(a.pipeline));

  return { sector_comparison: cmp, top_by_pipeline: cmp[0]||null, total_sectors: cmp.length };
}

// ── TOOL 6 ────────────────────────────────────────────────────────────────────
async function get_date_range_context() {
  const now = new Date(), q = getQuarter();
  const fyS = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear()-1;
  return {
    today: now.toISOString().split('T')[0],
    current_quarter: q.label, quarter_start: q.start, quarter_end: q.end,
    financial_year: `FY${fyS}-${(fyS+1).toString().slice(2)}`,
    fy_start: `${fyS}-04-01`, fy_end: `${fyS+1}-03-31`
  };
}

export const TOOL_DEFINITIONS = [
  { name: 'get_deal_pipeline', description: 'Fetch live deal pipeline from Monday.com. Returns counts, values, breakdowns by stage/status/sector/owner. Use for pipeline health, forecasting, sector analysis.', parameters: { type:'object', properties: { sector:{type:'string',description:'Mining,Powerline,Renewables,Railways,Aviation,Construction,DSP,or "energy"'}, status:{type:'string',description:'Open,Won,Dead,On Hold'}, stage:{type:'string',description:'Deal stage filter'}, owner:{type:'string',description:'OWNER_001 etc'}, this_quarter:{type:'boolean',description:'Only deals closing this quarter'} } } },
  { name: 'get_work_orders',   description: 'Fetch live work orders. Returns execution status, billing, collections, receivables. Use for revenue analysis, collection efficiency.', parameters: { type:'object', properties: { sector:{type:'string'}, status:{type:'string',description:'Completed,Ongoing,Not Started,Executed until current month'}, owner:{type:'string'} } } },
  { name: 'get_revenue_summary', description: 'Cross-board revenue: pipeline + actual + win rate + collection rate. Best for overall financial health.', parameters: { type:'object', properties: { sector:{type:'string'} } } },
  { name: 'get_owner_performance', description: 'Leaderboard: win rate, pipeline, won deals, work orders per owner.', parameters: { type:'object', properties:{} } },
  { name: 'get_sector_comparison', description: 'Compare all sectors: pipeline, win rate, work orders, revenue.', parameters: { type:'object', properties:{} } },
  { name: 'get_date_range_context', description: 'Current date, quarter, financial year. Call first for any time-based query.', parameters: { type:'object', properties:{} } }
];

export const TOOL_MAP = {
  get_deal_pipeline, get_work_orders, get_revenue_summary,
  get_owner_performance, get_sector_comparison, get_date_range_context
};
