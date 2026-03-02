import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const API_URL = 'https://api.monday.com/v2';
const KEY = process.env.MONDAY_API_KEY;

const data = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: KEY, 'API-Version': '2024-01' },
  body: JSON.stringify({ query: `{
    boards(ids:[${process.env.MONDAY_DEALS_BOARD_ID}]) {
      items_page(limit:3) {
        items {
          name
          column_values { id text }
        }
      }
    }
  }` })
}).then(r=>r.json());

const items = data.data.boards[0].items_page.items;
for (const item of items) {
  console.log('\nItem:', item.name);
  for (const cv of item.column_values) {
    if (cv.text) console.log(`  ${cv.id}: "${cv.text}"`);
  }
}
