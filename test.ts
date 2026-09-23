import { chromium } from 'playwright';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  console.log('Browser launched');
  const page = await browser.newPage();
  console.log('Page created');
  await page.goto('https://example.com');
  console.log('Navigated to example.com');
  const title = await page.title();
  console.log(`Title: ${title}`);
  await browser.close();
  console.log('Done');
})();