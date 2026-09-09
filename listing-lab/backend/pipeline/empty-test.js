const fs=require('fs');const {judgeComplianceVoted}=require('./compliance');const {inventoryFixed}=require('./inventory');
try{for(const l of fs.readFileSync('.env','utf8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}catch{}
const b=f=>fs.readFileSync(f).toString('base64');
const KEY=process.env.GEMINI_API_KEY, M='gemini-3.6-flash';
const FIXED=/curtain|drape|blind|rod|mount|ceiling|built-in|builtin|radiator|baseboard|heater|window ac|air condition|outlet|switch|vent|thermostat|smoke|fixture|fireplace|mantel|door|window/i;
(async()=>{
 const cases=[
  ['bedroom2.jpg','bedroom2.jpg','CONTROL untouched occupied room (must FAIL)'],
  ['bedroom1.jpg','out/bedroom1.empty.attempt1.raw.jpg','bedroom1 emptied (must PASS)'],
  ['bedroom2.jpg','out/bedroom2.empty.attempt1.raw.jpg','bedroom2 emptied (must PASS)'],
  ['bedroom2.jpg','out/bedroom1.empty.attempt1.raw.jpg','CONTROL wrong room (must FAIL)'],
 ];
 for(const [o,c,label] of cases){
  const kept=await inventoryFixed(KEY,b(o),'image/jpeg',M);
  const v=await judgeComplianceVoted(KEY,'empty',b(o),'image/jpeg',b(c),'image/jpeg',M,kept,3);
  console.log(label+' -> '+(v.pass?'PASS':'FAIL')+' ('+v.passes+'/3)'+(v.violations[0]?' | '+v.violations[0].slice(0,95):''));
 }
})()
