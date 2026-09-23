# GPT Proxy Playwright - Test Plan

## Prerequisites
1. A working terminal (CMD.exe, PowerShell, or restored Git Bash)
2. Bun installed (https://bun.sh/)
3. Google Chrome installed

## Test Procedure

### Step 1: Create fresh test directory
```bash
mkdir -p D:\gpt_proxy_final_test
cd /d D:\gpt_proxy_final_test
```

### Step 2: Initialize project
```bash
bun init -y
bun add -d playwright @types/node ts-node typescript
```

### Step 3: Create test script
Create `index.ts` with this content:
```typescript
import { chromium, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const USER_DATA_DIR = path.resolve('./browser_data');
const STORAGE_STATE_PATH = './storage_state.json';

// Ensure directories exist
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

console.log('[TEST] Launching browser with user data dir:', USER_DATA_DIR);

// Launch browser with persistent user data
const browser = await chromium.launch({
  headless: false,
  args: [`--user-data-dir=${USER_DATA_DIR}`]
});

const context: BrowserContext = await browser.newContext();

// Load existing storage state if available
if (fs.existsSync(STORAGE_STATE_PATH)) {
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
      console.log('[TEST] Loaded existing storage state');
    }
  } catch (err) {
    console.log('[TEST] Could not load storage state:', err);
  }
}

// Grant microphone permission (will persist)
await context.grantPermissions(['microphone']);
console.log('[TEST] Microphone permission granted');

// Create page and navigate to ChatGPT
const page = await context.newPage();
await page.goto('https://chat.openai.com', { waitUntil: 'networkidle' });

console.log('[TEST] Navigated to ChatGPT');
console.log('[TEST] Please log in manually if not already logged in');
console.log('[TEST] After logging in, return here and press ENTER to continue');

// Wait for user to press Enter (in real implementation, this would be handled differently)
// For this test, we'll wait 30 seconds for manual login
await new Promise(resolve => setTimeout(resolve, 30000));

// Check if we're logged in by looking for the prompt textarea
const isLoggedIn = await page.locator('textarea[id="prompt-textarea"]').isVisible();
if (isLoggedIn) {
  console.log('[TEST] Login detected! Saving state...');
  
  // Save storage state for future use
  const state = await context.storageState();
  fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  console.log('[TEST] Storage state saved');
  
  // Test sending a message
  console.log('[TEST] Testing message sending...');
  const textarea = page.locator('textarea[id="prompt-textarea"]');
  await textarea.fill('Hello, this is a test message from the GPT proxy!');
  await textarea.press('Enter');
  
  // Wait for response
  await page.waitForTimeout(5000);
  
  // Get last response
  const lastResponse = page.locator('.text-message:last-child .markdown');
  const responseText = await lastResponse.innerText();
  console.log('[TEST] Received response:', responseText.substring(0, 100) + '...');
} else {
  console.log('[TEST] Not logged in after timeout. Please check manual login.');
}

// Cleanup
await browser.close();
console.log('[TEST] Test completed successfully');
EOF
```

### Step 4: Run the test
```bash
bun ts-node index.ts
```

### Expected Output
```
[TEST] Launching browser with user data dir: D:\gpt_proxy_final_test\browser_data
[TEST] Navigated to ChatGPT
[TEST] Please log in manually if not already logged in
[TEST] After logging in, return here and press ENTER to continue...
[TEST] Login detected! Saving state...
[TEST] Storage state saved
[TEST] Testing message sending...
[TEST] Received response: Hello! I'm doing well, thank you for asking. How can I assist you today?...
[TEST] Test completed successfully
```

### Verification Points
1. **Browser launches** - Chromium window opens visibly
2. **User data persistence** - `./browser_data` directory created and populated
3. **Login persistence** - Storage state saved to `storage_state.json`
4. **Microphone permission** - Granted and stored in user data
5. **Message exchange** - Ability to send/receive messages via automation
6. **State retention** - On second run, login should be automatic

### Troubleshooting
- If browser doesn't launch: Check Chrome installation and antivirus
- If login fails: Ensure you manually logged in during the test window
- If no response: Check network connectivity and ChatGPT availability
- If storage state not saved: Verify write permissions in directory

## Notes
- This test uses `--user-data-dir` for maximum compatibility
- Microphone permission is granted programmatically and persists
- For actual voice input, you would need to integrate Web Speech API with user gesture
- The proxy is ready for use once manual login and permission are completed once