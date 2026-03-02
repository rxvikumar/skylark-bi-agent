import fetch from 'node-fetch';
import https from 'https';

// Bypass proxy/SSL issues
const agent = new https.Agent({ 
  rejectUnauthorized: false,
  timeout: 30000
});
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = process.platform === 'win32' ? (process.env.TEMP || 'C:\\Windows\\Temp') : '/tmp';

const API_URL = 'https://api.monday.com/v2';
const KEY = process.env.MONDAY_API_KEY;
const DEALS_ID = process.env.MONDAY_DEALS_BOARD_ID;
const WO_ID    = process.env.MONDAY_WORKORDERS_BOARD_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(query, variables = {}, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: KEY, 'API-Version': '2024-01' },
        body: JSON.stringify({ query, variables }),
        agent,
        timeout: 30000
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch(e) {
        console.log(`  ⚠️  Bad JSON (attempt ${attempt}/${retries}): ${text.slice(0,60)}`);
        if (attempt < retries) { await sleep(5000 * attempt); continue; }
        throw new Error('API returned invalid JSON after retries');
      }
      if (data.errors) {
        const e = data.errors[0];
        if (e.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED') {
          const wait = (e.extensions.retry_in_seconds || 20) * 1000 + 2000;
          console.log(`  ⏸️  Rate limited — waiting ${Math.ceil(wait/1000)}s...`);
          await sleep(wait);
          continue;
        }
        throw new Error(e.message || JSON.stringify(e));
      }
      return data.data;
    } catch(e) {
      if (e.message.includes('invalid JSON after retries')) throw e;
      if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.message.includes('fetch')) {
        console.log(`  ⚠️  Network error (attempt ${attempt}/${retries}): ${e.message.slice(0,60)}`);
        if (attempt < retries) { await sleep(5000 * attempt); continue; }
      }
      throw e;
    }
  }
}

// ── Excel parser ──────────────────────────────────────────────────────────────
const PARSE_PY = `
import zipfile, xml.etree.ElementTree as ET, json, sys
def read_xlsx(path):
    with zipfile.ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            tree = ET.parse(z.open('xl/sharedStrings.xml'))
            for si in tree.getroot().iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                t = ''.join(x.text or '' for x in si.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'))
                strings.append(t)
        tree = ET.parse(z.open('xl/worksheets/sheet1.xml'))
        ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        rows = []
        for row in tree.getroot().iter(f'{{{ns}}}row'):
            cells = []
            for c in row:
                t = c.get('t','')
                v = c.find(f'{{{ns}}}v')
                if v is None: cells.append(None)
                elif t == 's': cells.append(strings[int(v.text)])
                else: cells.append(v.text)
            rows.append(cells)
        return rows
print(json.dumps(read_xlsx(sys.argv[1])))
`;

function readExcel(filepath) {
  const tmp = path.join(TEMP_DIR, '_xlsx_parser.py');
  fs.writeFileSync(tmp, PARSE_PY);
  try {
    return JSON.parse(execSync(`python "${tmp}" "${filepath}"`, { maxBuffer: 50*1024*1024 }).toString());
  } catch {
    return JSON.parse(execSync(`python3 "${tmp}" "${filepath}"`, { maxBuffer: 50*1024*1024 }).toString());
  }
}

function findFile(keywords) {
  const searchDirs = [__dirname, path.join(__dirname, '../import'), path.join(__dirname, '../../import')];
  for (const dir of searchDirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.xlsx') && !f.endsWith('.xls')) continue;
        if (keywords.some(k => f.toLowerCase().includes(k.toLowerCase()))) {
          return path.join(dir, f);
        }
      }
    } catch(e) {}
  }
  return null;
}

function clean(v) { return v == null ? '' : String(v).trim(); }

function toDate(serial) {
  if (!serial) return null;
  const s = parseFloat(serial);
  if (isNaN(s) || s < 40000 || s > 60000) return null;
  return new Date((s - 25569) * 86400 * 1000).toISOString().split('T')[0];
}

function safeNum(v) {
  if (!v) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ── Clear all items from a board ──────────────────────────────────────────────
async function clearBoard(boardId, name) {
  console.log(`\n🗑️  Clearing ${name}...`);
  let total = 0;
  while (true) {
    const data = await gql(`{ boards(ids:[${boardId}]) { items_page(limit:50) { items { id } } } }`);
    const items = data.boards[0].items_page.items;
    if (!items.length) break;
    for (const item of items) {
      await gql(`mutation { delete_item(item_id: ${item.id}) { id } }`);
      total++;
      await sleep(200);
    }
    process.stdout.write(`\r  Deleted ${total} items...`);
  }
  console.log(`\n  ✓ ${name} cleared (${total} items removed)`);
}

// ── Create a column ───────────────────────────────────────────────────────────
async function createCol(boardId, title, type) {
  try {
    const d = await gql(
      `mutation($b:ID!,$t:String!,$ct:ColumnType!) { create_column(board_id:$b, title:$t, column_type:$ct) { id } }`,
      { b: String(boardId), t: title, ct: type }
    );
    await sleep(400);
    return d.create_column.id;
  } catch(e) {
    console.log(`  ⚠️  Col "${title}": ${e.message.slice(0,80)}`);
    return null;
  }
}

// ── Get column map {title -> id} ──────────────────────────────────────────────
async function getColMap(boardId) {
  const d = await gql(`{ boards(ids:[${boardId}]) { columns { id title } } }`);
  const map = {};
  for (const c of d.boards[0].columns) map[c.title] = c.id;
  return map;
}

// ── Create item ───────────────────────────────────────────────────────────────
async function createItem(boardId, name, colVals) {
  const cv = Object.fromEntries(
    Object.entries(colVals).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
  );
  return gql(
    `mutation($b:ID!,$n:String!,$cv:JSON!) { create_item(board_id:$b, item_name:$n, column_values:$cv) { id } }`,
    { b: String(boardId), n: String(name).slice(0, 255), cv: JSON.stringify(cv) }
  );
}

// ── Setup Deal Funnel columns ─────────────────────────────────────────────────
async function setupDeals() {
  console.log('\n🏗️  Creating Deal Funnel columns...');
  await createCol(DEALS_ID, 'Owner Code', 'text');
  await createCol(DEALS_ID, 'Client Code', 'text');
  await createCol(DEALS_ID, 'Deal Status', 'text');
  await createCol(DEALS_ID, 'Close Date', 'date');
  await createCol(DEALS_ID, 'Closure Probability', 'text');
  await createCol(DEALS_ID, 'Deal Value', 'numbers');
  await createCol(DEALS_ID, 'Tentative Close Date', 'date');
  await createCol(DEALS_ID, 'Deal Stage', 'text');
  await createCol(DEALS_ID, 'Product', 'text');
  await createCol(DEALS_ID, 'Sector', 'text');
  await createCol(DEALS_ID, 'Created Date', 'date');
  console.log('  ✓ Deal Funnel columns created');
}

// ── Setup Work Orders columns ─────────────────────────────────────────────────
async function setupWO() {
  console.log('\n🏗️  Creating Work Orders columns...');
  await createCol(WO_ID, 'Customer Code', 'text');
  await createCol(WO_ID, 'Serial No', 'text');
  await createCol(WO_ID, 'Nature of Work', 'text');
  await createCol(WO_ID, 'Last Executed Month', 'text');
  await createCol(WO_ID, 'Execution Status', 'text');
  await createCol(WO_ID, 'Data Delivery Date', 'date');
  await createCol(WO_ID, 'Date of PO', 'date');
  await createCol(WO_ID, 'Document Type', 'text');
  await createCol(WO_ID, 'Sector', 'text');
  await createCol(WO_ID, 'BD KAM Code', 'text');
  await createCol(WO_ID, 'Amount Excl GST', 'numbers');
  await createCol(WO_ID, 'Billed Value', 'numbers');
  await createCol(WO_ID, 'Collected Amount', 'numbers');
  await createCol(WO_ID, 'Amount Receivable', 'numbers');
  await createCol(WO_ID, 'Billing Status', 'text');
  await createCol(WO_ID, 'WO Status', 'text');
  await createCol(WO_ID, 'Invoice Status', 'text');
  console.log('  ✓ Work Orders columns created');
}

// ── Import Deal Funnel ────────────────────────────────────────────────────────
// Columns: A(0)=Deal Name, B(1)=Owner Code, C(2)=Client Code, D(3)=Deal Status,
//          E(4)=Close Date, F(5)=Closure Probability, G(6)=Deal Value,
//          H(7)=Tentative Close Date, I(8)=Deal Stage, J(9)=Product,
//          K(10)=Sector, L(11)=Created Date
async function importDeals(cols) {
  const file = findFile(['deal funnel', 'deal_funnel', 'deals']);
  if (!file) { console.log('\n❌ Deal Funnel Excel not found! Put it in backend/ or import/ folder'); return 0; }
  console.log('\n📊 Importing Deal Funnel from:', path.basename(file));
  
  const rows = readExcel(file);
  let ok = 0, skip = 0;

  // Row 0 = header, start from row 1
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[0]);
    if (!name || name.toLowerCase() === 'deal name') { skip++; continue; }

    const cv = {};
    if (cols['Owner Code']          && clean(r[1]))  cv[cols['Owner Code']]          = clean(r[1]);
    if (cols['Client Code']         && clean(r[2]))  cv[cols['Client Code']]         = clean(r[2]);
    if (cols['Deal Status']         && clean(r[3]))  cv[cols['Deal Status']]         = clean(r[3]);
    if (cols['Closure Probability'] && clean(r[5]))  cv[cols['Closure Probability']] = clean(r[5]);
    if (cols['Deal Stage']          && clean(r[8]))  cv[cols['Deal Stage']]          = clean(r[8]);
    if (cols['Product']             && clean(r[9]))  cv[cols['Product']]             = clean(r[9]);
    if (cols['Sector']              && clean(r[10])) cv[cols['Sector']]              = clean(r[10]);
    if (cols['Deal Value']          && safeNum(r[6])) cv[cols['Deal Value']]         = safeNum(r[6]);

    const d1 = toDate(r[4]);
    if (d1 && cols['Close Date'])          cv[cols['Close Date']]          = { date: d1 };
    const d2 = toDate(r[7]);
    if (d2 && cols['Tentative Close Date']) cv[cols['Tentative Close Date']] = { date: d2 };
    const d3 = toDate(r[11]);
    if (d3 && cols['Created Date'])        cv[cols['Created Date']]        = { date: d3 };

    try {
      await createItem(DEALS_ID, name, cv);
      ok++;
      if (ok % 20 === 0) process.stdout.write(`\r  ⏳ ${ok} deals imported...`);
      await sleep(300);
    } catch(e) {
      skip++;
      if (skip <= 5) console.log(`\n  ⚠️  Row ${i+1} skipped: ${e.message.slice(0,80)}`);
    }
  }
  console.log(`\n  ✅ Deals: ${ok} imported, ${skip} skipped`);
  return ok;
}

// ── Import Work Orders ────────────────────────────────────────────────────────
// Row 1 = blank, Row 2 = headers, data starts Row 3 (index 2)
// A(0)=Deal Name, B(1)=Customer Code, C(2)=Serial#, D(3)=Nature of Work,
// E(4)=Last Executed Month, F(5)=Execution Status, G(6)=Data Delivery Date,
// H(7)=Date of PO/LOI, I(8)=Document Type
// Further right: Sector, BD KAM, Amount columns (need to check)
async function importWorkOrders(cols) {
  const file = findFile(['work_order', 'work order', 'workorder', 'tracker']);
  if (!file) { console.log('\n❌ Work Orders Excel not found! Put it in backend/ or import/ folder'); return 0; }
  console.log('\n🔧 Importing Work Orders from:', path.basename(file));

  const rows = readExcel(file);
  let ok = 0, skip = 0;

  // Print first data row to verify columns
  if (rows[2]) {
    console.log('  First data row sample:', rows[2].slice(0,10).map((v,i)=>`[${i}]=${v}`).join(', '));
  }

  // Headers are in row index 1 (row 2 in Excel), data starts at index 2
  const headers = (rows[1] || []).map(h => clean(h).toLowerCase());
  console.log('  Headers detected:', headers.slice(0,12).join(' | '));

  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[0]);
    if (!name || name.toLowerCase().includes('deal name')) { skip++; continue; }

    // EXACT column positions from Excel (0-indexed):
    // A(0)=Deal Name, B(1)=Customer Code, C(2)=Serial#, D(3)=Nature of Work
    // E(4)=Last Executed Month, F(5)=Execution Status, G(6)=Data Delivery Date
    // H(7)=Date of PO/LOI, I(8)=Document Type, J(9)=Probable Start Date
    // K(10)=Probable End Date, L(11)=BD/KAM Personnel code, M(12)=Sector
    // N(13)=Type of Work, R(17)=Amount Excl GST, S(18)=Amount Incl GST
    // T(19)=Billed Value Excl GST, V(21)=Collected Amount Incl GST
    // W(22)=Amount to be billed Excl GST, Y(24)=Amount Receivable
    // AE(30)=Invoice Status, AH(33)=WO Status(billed), AK(36)=Collection Status, AL(37)=Billing Status

    const cv = {};
    if (cols['Customer Code']      && clean(r[1]))   cv[cols['Customer Code']]       = clean(r[1]);
    if (cols['Serial No']          && clean(r[2]))   cv[cols['Serial No']]           = clean(r[2]);
    if (cols['Nature of Work']     && clean(r[3]))   cv[cols['Nature of Work']]      = clean(r[3]);
    if (cols['Last Executed Month']&& clean(r[4]))   cv[cols['Last Executed Month']] = clean(r[4]);
    if (cols['Execution Status']   && clean(r[5]))   cv[cols['Execution Status']]    = clean(r[5]);
    if (cols['Document Type']      && clean(r[8]))   cv[cols['Document Type']]       = clean(r[8]);
    if (cols['BD KAM Code']        && clean(r[11]))  cv[cols['BD KAM Code']]         = clean(r[11]);
    if (cols['Sector']             && clean(r[12]))  cv[cols['Sector']]              = clean(r[12]);
    if (cols['Type of Work']       && clean(r[13]))  cv[cols['Type of Work']]        = clean(r[13]);
    if (cols['Amount Excl GST']    && safeNum(r[17])) cv[cols['Amount Excl GST']]    = safeNum(r[17]);
    if (cols['Billed Value']       && safeNum(r[19])) cv[cols['Billed Value']]       = safeNum(r[19]);
    if (cols['Collected Amount']   && safeNum(r[21])) cv[cols['Collected Amount']]   = safeNum(r[21]);
    if (cols['Amount Receivable']  && safeNum(r[24])) cv[cols['Amount Receivable']]  = safeNum(r[24]);
    if (cols['Invoice Status']     && clean(r[30]))  cv[cols['Invoice Status']]      = clean(r[30]);
    if (cols['WO Status']          && clean(r[33]))  cv[cols['WO Status']]           = clean(r[33]);
    if (cols['Billing Status']     && clean(r[37]))  cv[cols['Billing Status']]      = clean(r[37]);

    const dpo = toDate(r[7]);
    if (dpo && cols['Date of PO']) cv[cols['Date of PO']] = { date: dpo };
    const ddd = toDate(r[6]);
    if (ddd && cols['Data Delivery Date']) cv[cols['Data Delivery Date']] = { date: ddd };
    const ds = toDate(r[9]);
    if (ds && cols['Start Date']) cv[cols['Start Date']] = { date: ds };
    const de = toDate(r[10]);
    if (de && cols['End Date']) cv[cols['End Date']] = { date: de };

    try {
      await createItem(WO_ID, name, cv);
      ok++;
      if (ok % 20 === 0) process.stdout.write(`\r  ⏳ ${ok} work orders imported...`);
      await sleep(300);
    } catch(e) {
      skip++;
      if (skip <= 5) console.log(`\n  ⚠️  Row ${i+1} skipped: ${e.message.slice(0,80)}`);
    }
  }
  console.log(`\n  ✅ Work Orders: ${ok} imported, ${skip} skipped`);
  return ok;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Monday.com Complete Setup & Import v2  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Deals Board:  ${DEALS_ID}`);
  console.log(`WO Board:     ${WO_ID}`);

  // 1. Clear boards
  await clearBoard(DEALS_ID, 'Deal Funnel');
  await clearBoard(WO_ID, 'Work Orders');

  // 2. Create columns
  await setupDeals();
  await setupWO();

  // 3. Get column ID maps
  console.log('\n🔍 Reading column IDs...');
  const dealCols = await getColMap(DEALS_ID);
  const woCols   = await getColMap(WO_ID);
  console.log('Deal cols:', Object.keys(dealCols).filter(k=>k!=='Name').join(', '));
  console.log('WO cols:  ', Object.keys(woCols).filter(k=>k!=='Name').join(', '));

  // 4. Import data
  const dealsOk = await importDeals(dealCols);
  const woOk    = await importWorkOrders(woCols);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  ✅ Done! ${dealsOk} deals + ${woOk} work orders  `);
  console.log('║  Open Monday.com to verify data         ║');
  console.log('╚══════════════════════════════════════════╝');
}

main().catch(e => { console.error('\n❌ Fatal error:', e.message); process.exit(1); });
