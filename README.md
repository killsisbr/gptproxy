# GPT Proxy with Playwright

This project demonstrates how to use Playwright to automate login and messaging on chat.openai.com, effectively creating a proxy for GPT interactions.

## Features

- Automates login to chat.openai.com (manual login only once, then uses stored state)
- Sends messages to ChatGPT and retrieves responses
- Simple CLI interface for sending messages
- Demonstrates how microphone input could be integrated (via Web Speech API, though not implemented due to environment limitations)

## Prerequisites

- [Bun](https://bun.sh/) (or Node.js/npm if you prefer)
- Playwright browsers (installed via dependencies)
- Google Chrome (optional, for using your existing Chrome profile)

## Setup

1. Clone or create the project directory.
2. Install dependencies:

```bash
bun install
```

## Configuration (Optional)

By default, the script uses an isolated user data directory (`./userData`) that will not interfere with your Chrome browser.

To use your existing Chrome profile (so you can leverage your logged-in Google account for SSO login to ChatGPT):

1. Edit `src/index.ts` and set:
   ```typescript
   const USE_CHROME_PROFILE = true;
   ```

2. For safety (recommended), keep:
   ```typescript
   const USE_PROFILE_COPY = true;
   ```
   This creates a temporary copy of your Chrome profile, allowing Chrome to remain open while the script runs.

3. If you set `USE_PROFILE_COPY = false`, you **MUST close all Chrome instances** before running the script to avoid conflicts.

## Usage

## Usage

Run the script with:

```bash
bun run dev
```

or

```bash
npx ts-node src/index.ts
```

On first run, a browser window will open. Please log in to chat.openai.com manually. After logging in, press Enter in the terminal to save the login state.

Subsequent runs will use the saved login state (storageState.json) to skip the login process.

Type your messages at the prompt and press Enter. Type "exit" to quit.

## How It Works

- The script launches Chromium in headed mode (visible browser) with a persistent user data directory.
- This persistent directory stores cookies, localStorage, IndexedDB, and granted permissions (like microphone) between runs.
- It checks for a saved login state (storageState.json) as a backup and loads cookies if available.
- If no saved state is found, it waits for you to log in manually in the browser.
- After login (manual or via saved state), it sends your input as a message to ChatGPT.
- It waits for the response and prints it to the console.
- Microphone permission, once granted, is persisted in the user data directory and will be available in future runs.

## Notes on Microphone Input

Integrating real microphone input would require capturing audio in the browser and converting it to text (e.g., using the Web Speech API). This is complex in an automated environment because:
- The Web Speech API requires user interaction to start in many browsers.
- Playwright automates a browser but does not grant direct access to the user's microphone without explicit permission prompts.

For demonstration purposes, one could use `page.evaluate` to inject JavaScript that attempts to use the Web Speech API, but it would likely require manual interaction to grant microphone access and start listening. Therefore, this project focuses on the text-based proxy.

## Customization

- To run in headless mode (invisible browser), change `headless: false` to `headless: true` in `src/index.ts`.
- Adjust selectors if the ChatGPT website changes (the script uses current selectors as of the time of writing).

## License

This project is for educational purposes only. Please use responsibly and in accordance with OpenAI's terms of service.