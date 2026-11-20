import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'opus.spec.mjs',workers:1,timeout:60000,reporter:'list',use:{baseURL:'https://sangeet-pitaraa.onrender.com',browserName:'chromium',channel:process.env.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : process.env.PLAYWRIGHT_CHANNEL,headless:true}});
