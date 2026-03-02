// import-data.mjs — Fixed for Windows + Monday.com status labels

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = process.platform === 'win32' ? (process.env.TEMP || 'C:\\Windows\\Temp') : '/tmp';

function loadEnv() {
  const envPath = path.join(__dirname, '../backend/.env');
  if (!fs.existsSync(envPath)) { console.error('❌ .env not found at', envPath); process.exit(1); }
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
}
loadEnv();

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const DEALS_BOARD_ID = process.env.MONDAY_DEALS_BOARD_ID;
const WO_BOARD_ID = process.env.MONDAY_WORKORDERS_BOARD_ID;

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

function readExcelFile(filepath) {
  const tmp = path.join(TEMP_DIR, '_xlsx_parser.py');
  fs.writeFileSync(tmp, PARSE_PY);
  try {
    const result = execSync(`python3 "${tmp}" "${filepath}"`, { maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(result.toString());
  } catch(e) {
    // Try python on Windows
    try {
      const result = execSync(`python "${tmp}" "${filepath}"`, { maxBuffer: 50 * 1024 * 1024 });
      return JSON.parse(result.toString());
    } catch(e2) {
      console.error('Failed to parse Excel:', e2.message);
      process.exit(1);
    }
  }
}

function findFile(keywords) {
  const searchDirs = [__dirname, path.join(__dirname, '..')];
  for (const dir of searchDirs) {
    try {
      for (const file of fs.readdirSync(dir)) {
        const fl = file.toLowerCase();
        if ((fl.endsWith('.xlsx') || fl.endsWith('.xls')) && keywords.some(k => fl.includes(k.toLowerCase()))) {
          return path.join(dir, file);
        }
      }
    } catch(e) {}
  }
  return null;
}

function excelDateToISO(serial) {
  if (!serial) return null;
  const s = parseFloat(serial);
  if (isNaN(s) || s < 40000 || s > 60000) return null;
  return new Date((s - 25569) * 86400 * 1000).toISOString().split('T')[0];
}

function clean(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mondayMutation(query, variables = {}) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: MONDAY_API_KEY, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) {
    const err = data.errors[0];
    // Rate limit — wait and retry
    if (err.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED') {
      const wait = (err.extensions.retry_in_seconds || 20) * 1000 + 2000;
      console.log(`   ⏸️  Rate limited — waiting ${Math.ceil(wait/1000)}s...`);
      await sleep(wait);
      return mondayMutation(query, variables); // retry
    }
    throw new Error(JSON.stringify(data.errors));
  }
  return data.data;
}

async function createItem(boardId, itemName, columnValues) {
  // Remove null/empty values
  const cleaned = Object.fromEntries(
    Object.entries(columnValues).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
  );
  return mondayMutation(`
    mutation($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
    }
  `, { boardId: String(boardId), itemName: String(itemName).substring(0, 255), columnValues: JSON.stringify(cleaned) });
}

// ─── IMPORT DEALS ─────────────────────────────────────────────────────────────
// Cols: 0:Deal Name, 1:Owner code, 2:Client Code, 3:Deal Status,
// 4:Close Date(A), 5:Closure Probability, 6:Masked Deal value,
// 7:Tentative Close Date, 8:Deal Stage, 9:Product deal, 10:Sector/service, 11:Created Date
async function importDeals(filepath) {
  console.log('\n📊 Importing Deal Funnel...');
  const rows = readExcelFile(filepath);
  console.log(`   Found ${rows.length - 1} data rows\n`);

  let ok = 0, skip = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = clean(row[0]);
    if (!name || name === 'Deal Name') { skip++; continue; }

    const cv = {
      text:    clean(row[1]),   // Owner code
      text1:   clean(row[2]),   // Client Code
      text2:   clean(row[3]),   // Deal Status (as plain text)
      text3:   clean(row[5]),   // Closure Probability
      numbers: parseFloat(row[6]) || null, // Deal Value
      text4:   clean(row[8]),   // Deal Stage
      text5:   clean(row[9]),   // Product deal
      text6:   clean(row[10]),  // Sector/service
    };
    const d1 = excelDateToISO(row[4]);  if (d1) cv.date  = { date: d1 };
    const d2 = excelDateToISO(row[7]);  if (d2) cv.date1 = { date: d2 };
    const d3 = excelDateToISO(row[11]); if (d3) cv.date2 = { date: d3 };

    try {
      await createItem(DEALS_BOARD_ID, name, cv);
      ok++;
      if (ok % 25 === 0) console.log(`   ⏳ ${ok} deals imported...`);
      await sleep(300); // avoid rate limits
    } catch(e) {
      console.error(`   ❌ Row ${i} (${name}): ${e.message.substring(0, 80)}`);
      skip++;
    }
  }
  console.log(`✅ Deals: ${ok} imported, ${skip} skipped`);
}

// ─── IMPORT WORK ORDERS ───────────────────────────────────────────────────────
// Row 0=blank, Row 1=headers, Row 2+=data
// Key cols: 0:Deal name, 1:Customer, 2:Serial#, 3:Nature of Work,
// 4:Last exec month, 5:Execution Status, 7:PO Date, 8:Doc Type,
// 9:Start Date, 10:End Date, 11:BD/KAM code, 12:Sector, 13:Type of Work,
// 17:Amount(excl GST), 18:Amount(incl GST), 19:Billed(excl), 21:Collected,
// 24:Receivable, 30:Invoice Status, 34:WO Status, 37:Billing Status
async function importWorkOrders(filepath) {
  console.log('\n🔧 Importing Work Orders...');
  const rows = readExcelFile(filepath);
  console.log(`   Found ${rows.length - 2} data rows\n`);

  let ok = 0, skip = 0;
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    const name = clean(row[0]);
    if (!name || name === 'Deal name masked') { skip++; continue; }

    const cv = {
      text:     clean(row[1]),   // Customer Name Code
      text1:    clean(row[2]),   // Serial #
      text2:    clean(row[3]),   // Nature of Work
      text3:    clean(row[4]),   // Last executed month
      text4:    clean(row[5]),   // Execution Status (plain text)
      text5:    clean(row[8]),   // Document Type
      text6:    clean(row[11]),  // BD/KAM Personnel code
      text7:    clean(row[12]),  // Sector
      text8:    clean(row[13]),  // Type of Work
      numbers:  parseFloat(row[17]) || null,  // Amount Excl GST
      numbers1: parseFloat(row[18]) || null,  // Amount Incl GST
      numbers2: parseFloat(row[19]) || null,  // Billed Value Excl GST
      numbers3: parseFloat(row[21]) || null,  // Collected Amount
      numbers4: parseFloat(row[24]) || null,  // Amount Receivable
      text9:    clean(row[30]),  // Invoice Status
      text10:   clean(row[34]), // WO Status
      text11:   clean(row[37]), // Billing Status
    };
    const d1 = excelDateToISO(row[7]);  if (d1) cv.date  = { date: d1 };
    const d2 = excelDateToISO(row[9]);  if (d2) cv.date1 = { date: d2 };
    const d3 = excelDateToISO(row[10]); if (d3) cv.date2 = { date: d3 };

    try {
      await createItem(WO_BOARD_ID, name, cv);
      ok++;
      if (ok % 25 === 0) console.log(`   ⏳ ${ok} work orders imported...`);
      await sleep(300);
    } catch(e) {
      console.error(`   ❌ Row ${i} (${name}): ${e.message.substring(0, 80)}`);
      skip++;
    }
  }
  console.log(`✅ Work Orders: ${ok} imported, ${skip} skipped`);
}

async function main() {
  console.log('🚀 Monday.com Importer v2\n');

  if (!MONDAY_API_KEY || MONDAY_API_KEY.includes('your_')) { console.error('❌ Set MONDAY_API_KEY in backend/.env'); process.exit(1); }
  if (!DEALS_BOARD_ID || DEALS_BOARD_ID.includes('your_')) { console.error('❌ Set MONDAY_DEALS_BOARD_ID in backend/.env'); process.exit(1); }
  if (!WO_BOARD_ID || WO_BOARD_ID.includes('your_')) { console.error('❌ Set MONDAY_WORKORDERS_BOARD_ID in backend/.env'); process.exit(1); }

  const dealsFile = findFile(['deal funnel', 'deal_funnel', 'dealfunnel', 'deals']);
  const woFile    = findFile(['work_order', 'work order', 'workorder']);

  if (!dealsFile) { console.error('❌ Deal Funnel Excel not found in import/ folder'); process.exit(1); }
  if (!woFile)    { console.error('❌ Work Order Excel not found in import/ folder'); process.exit(1); }

  console.log('📁 Deal Funnel:', dealsFile);
  console.log('📁 Work Orders:', woFile);

  await importDeals(dealsFile);
  await importWorkOrders(woFile);

  console.log('\n🎉 Done! Open your Monday.com boards to verify.');
}

main().catch(err => { console.error('💥 Failed:', err.message); process.exit(1); });
