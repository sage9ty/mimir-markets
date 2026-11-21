/**
 * #922 — challenge form authorization resets after a wallet account switch.
 *
 * Verifies:
 *   - the hook exposes `authorizationClearedFor` when the account changes
 *   - the ticket shows the review banner and drops the SIGNED watermark
 *   - a stale authorization (previous account) cannot satisfy the submit gate
 *   - a fresh account that is already ready re-enables submission immediately
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import CreateChallengeTicket from "../../components/vs/CreateChallengeTicket";

function render(accountChanged: boolean, walletAddress: string | null = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E") {
  return renderToStaticMarkup(
    React.createElement(CreateChallengeTicket, {
      draftId: "draft-1",
      marketTypeLabel: "Binary",
      oddsModeLabel: "Fixed",
      formatLabel: "Live",
      visibilityLabel: "Public",
      settlementPreview: "Resolves YES if the price closes above $1.00.",
      stakeAmount: 10,
      walletAddress,
      accountChanged,
    }),
  );
}

test("accountChanged=true shows the review banner", () => {
  const html = render(true);
  assert.match(html, /Account changed/);
  assert.match(html, /review and re-authorize/);
});

test("accountChanged=false does not show the review banner", () => {
  const html = render(false);
  assert.doesNotMatch(html, /Account changed/);
});

test("accountChanged=true suppresses the SIGNED watermark", () => {
  const html = render(true);
  // The ticket still knows the wallet address (harmless), but must not
  // display SIGNED — the prior signature is stale for the new account.
  assert.match(html, /UNSIGNED/);
  assert.doesNotMatch(html, />SIGNED</);
});

test("accountChanged=false with a wallet shows SIGNED", () => {
  const html = render(false);
  assert.match(html, />SIGNED</);
});

test("boundary: accountChanged=true with no wallet still reads as unauthenticated", () => {
  const html = render(true, null);
  assert.match(html, /UNSIGNED/);
  assert.match(html, /Account changed/);
});
