// SPDX-License-Identifier: GPL-3.0-only
/**
 * The two phones on the bench: a page each, in one browser context.
 *
 * Shared by the mesh-only suite and the one that also brings the internet path
 * up, so that both open a phone the same way.
 */
import { expect } from "@playwright/test";

export const room = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export async function openPhone(context, roomId, extra = "") {
  const page = await context.newPage();
  await page.goto(`/?mesh=bc&room=${roomId}&preset=SHORT_TURBO${extra}`);
  await expect(page.getByText("BroadcastChannel (fake mesh)", { exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}
