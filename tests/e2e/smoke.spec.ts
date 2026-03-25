import { test, expect, _electron as electron } from '@playwright/test';

test('desktop shell renders core voice UI', async () => {
  const app = await electron.launch({ args: ['.'] });

  const window = await app.firstWindow();
  const hasBridge = await window.evaluate(() => typeof window.chetBot !== 'undefined');

  await expect(window.getByRole('heading', { name: 'Chet Bot' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Start Conversation' })).toBeVisible();
  await expect(window.getByText('Voice Desktop Agent')).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(window.getByText('API Key')).toBeVisible();
  await expect(hasBridge).toBeTruthy();

  await app.close();
});
