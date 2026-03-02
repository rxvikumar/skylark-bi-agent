import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const MONDAY_API_URL = 'https://api.monday.com/v2';

async function query(q) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY, 'API-Version': '2024-01' },
    body: JSON.stringify({ query: q })
  });
  return (await res.json()).data;
}

// Get first 2 items from deals board with ALL column values
const dealsData = await query(`{
  boards(ids: [${process.env.MONDAY_DEALS_BOARD_ID}]) {
    columns { id title type }
    items_page(limit: 2) {
      items {
        id name
        column_values { id text value }
      }
    }
  }
}`);

console.log('\n=== DEAL FUNNEL COLUMNS ===');
dealsData.boards[0].columns.forEach(c => console.log(`  ${c.id} | ${c.title} | ${c.type}`));

console.log('\n=== SAMPLE DEAL ITEM ===');
const item = dealsData.boards[0].items_page.items[0];
console.log('Name:', item.name);
item.column_values.forEach(c => { if(c.text) console.log(`  ${c.id}: "${c.text}"`) });

// Get work orders columns
const woData = await query(`{
  boards(ids: [${process.env.MONDAY_WORKORDERS_BOARD_ID}]) {
    columns { id title type }
    items_page(limit: 2) {
      items {
        id name
        column_values { id text value }
      }
    }
  }
}`);

console.log('\n=== WORK ORDERS COLUMNS ===');
woData.boards[0].columns.forEach(c => console.log(`  ${c.id} | ${c.title} | ${c.type}`));

console.log('\n=== SAMPLE WORK ORDER ITEM ===');
const wo = woData.boards[0].items_page.items[0];
console.log('Name:', wo.name);
wo.column_values.forEach(c => { if(c.text) console.log(`  ${c.id}: "${c.text}"`) });
