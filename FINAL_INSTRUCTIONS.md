# GPT Proxy Playwright - Final Instructions

## Project Location
`D:\JARVIS\gpt-proxy-playwright`

## Prerequisites
1. **Working command line**: Use **cmd.exe** (not Git Bash/PowerShell) due to shell environment issues
2. **Bun installed**: https://bun.sh/
3. **Google Chrome installed**

## Setup
1. Open **cmd.exe** (Win+R → type `cmd` → Enter)
2. Navigate to the project directory:
   ```cmd
   cd /d D:\JARVIS\gpt-proxy-playwright
   ```
3. Install dependencies (first time only):
   ```cmd
   bun install
   ```

## Usage
1. Run the proxy:
   ```cmd
   bun src/index.ts
   ```
2. On first run:
   - A Chromium window will open
   - **Log in to ChatGPT manually** if not already logged in (use your Google account)
   - **Grant microphone permission** when prompted by the browser (this will be saved)
   - After logging in, **press Enter in the cmd.exe window** to continue
3. On subsequent runs:
   - Login and microphone permission will be restored automatically
   - The Chromium window will open directly to ChatGPT ready to use
4. Use the proxy:
   - Type your message at the `You: ` prompt in cmd.exe
   - Press Enter
   - Wait for the GPT response to appear as `GPT: [text]`
   - Type `exit` and press Enter to quit

## How It Works
- Uses `--user-data-dir` to persist browser data (cookies, localStorage, IndexedDB, permissions)
- On first run, waits for manual login and saves state to `storageState.json`
- Grants microphone permission persistently
- Launches browser in visible mode so you can see the automation
- Sends your input as a message to ChatGPT and retrieves the response

## Important Notes
- **Always use cmd.exe** for running this proxy (your Git Bash/PowerShell shell is broken)
- Your normal Chrome browser remains unaffected (we use an isolated user data directory)
- Microphone permission is saved and will persist, but to actually use audio input you would need to integrate Web Speech API with a user gesture (click to start listening) due to browser security restrictions
- The proxy is ready for use once you've completed the manual login and permission grant once

## Troubleshooting
- If you see "chromium.launch is not a function": Reinstall playwright with `bun add -d playwright`
- If the browser doesn't launch: Check that Chrome is installed and not blocked by antivirus
- If login doesn't persist: Ensure you're not clearing browser data and that the user data directory is writable
- If you get Exit code 2: You are not using cmd.exe - switch to cmd.exe immediately

## Files
- `src/index.ts` - Main TypeScript script
- `package.json` - Dependencies and scripts
- `README.md` - Detailed instructions
- `storageState.json` - Created after first login (backup of cookies)
- `./userData/` - Persistent browser data directory (created on first run)

## Success Criteria
1. Chromium window opens to ChatGPT
2. You can log in manually (first run only)
3. After pressing Enter in cmd.exe, you see "You can now send messages to ChatGPT."
4. You type a message, press Enter, and see a GPT response
5. On second run, steps 2-3 happen automatically (no manual login needed)

This proxy is now ready for use. For any further assistance, run the commands above in cmd.exe.