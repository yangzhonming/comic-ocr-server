const fs = require('fs');

// 从 capture.js 中读取并提取 toReadingCase 函数
const captureContent = fs.readFileSync(__dirname + '/../capture.js', 'utf8');
const vm = require('vm');
const sandbox = {
  globalThis: {},
  console,
  document: { addEventListener: () => {} },
  window: { addEventListener: () => {} }
};
vm.createContext(sandbox);
vm.runInContext(captureContent, sandbox);

const toReadingCase = sandbox.globalThis.ComicTextTransform?.toReadingCase;
if (!toReadingCase) {
  console.error('FAIL: toReadingCase not found on globalThis.ComicTextTransform');
  process.exit(1);
}

const tests = [
  {
    name: '多行英文原句 + 短语人名专名保护',
    input: "THE SWORD\nIMMORTAL WAS REVERED AS\nTHE GREATEST SWORDSMAN\nUNDER HEAVEN,",
    glossary: { "sword immortal": "Sword Immortal" },
    expected: "The Sword\nImmortal was revered as\nthe greatest swordsman\nunder heaven,"
  },
  {
    name: '人名缩写与代词测试',
    input: "I CAN'T BELIEVE IT! DR. STONE IS REAL... BUT WHO ARE YOU?",
    glossary: { "stone": "Stone" },
    expected: "I can't believe it! Dr. Stone is real... but who are you?"
  },
  {
    name: '尊称与地名测试',
    input: "HELLO, MR. WAYNE. WELCOME TO GOTHAM.",
    glossary: { "wayne": "Wayne", "gotham": "Gotham" },
    expected: "Hello, Mr. Wayne. Welcome to Gotham."
  },
  {
    name: '拟声大喊与否定缩写',
    input: "WHAT?! NOOO! DON'T TOUCH THAT!",
    glossary: {},
    expected: "What?! Nooo! Don't touch that!"
  }
];

let allPassed = true;
for (const t of tests) {
  const actual = toReadingCase(t.input, t.glossary);
  console.log(`=== 测试项: ${t.name} ===`);
  console.log('输入:\n' + t.input);
  console.log('输出:\n' + actual);
  console.log('-------------------------------------------');
}

console.log('所有测试执行完毕！');
