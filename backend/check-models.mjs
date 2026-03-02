import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GEMINI_API_KEY;
if (!key) { console.log('❌ No GEMINI_API_KEY in .env'); process.exit(1); }

console.log('🔑 Key starts with:', key.slice(0,10) + '...');
console.log('Checking available models...\n');

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
const data = await res.json();

if (!res.ok) {
  console.log('❌ API Error:', data.error?.message);
  process.exit(1);
}

const models = (data.models || [])
  .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
  .map(m => m.name.replace('models/', ''));

console.log('✅ Models that support generateContent:');
models.forEach(m => console.log('  -', m));

// Test the first flash model
const flashModel = models.find(m => m.includes('flash'));
if (flashModel) {
  console.log(`\n🧪 Testing ${flashModel}...`);
  const testRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${flashModel}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say: WORKING' }] }] })
    }
  );
  const testData = await testRes.json();
  if (testRes.ok) {
    console.log('✅ Test passed! Response:', testData.candidates?.[0]?.content?.parts?.[0]?.text);
    console.log(`\n✅ USE THIS MODEL: ${flashModel}`);
  } else {
    console.log('❌ Test failed:', testData.error?.message);
  }
}
