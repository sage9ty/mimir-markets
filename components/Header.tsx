"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import {
  WALLET_SIGNING_OPERATION_MESSAGE_KEYS,
  useWallet,
} from "@/lib/wallet";
import { shortenAddress } from "@/lib/constants";
import { getExplorerAddressUrl } from "@/lib/stellar";
import { Copy, ExternalLink, LogOut, Menu, X } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { isXmtpFeatureEnabled } from "@/lib/xmtp/config";
import type { WalletSigningOperationRecord } from "@/lib/wallet-signing-coordinator";

function SigningRecoveryNotice({
  record,
  onAcknowledge,
  variant = "menu",
}: {
  record: WalletSigningOperationRecord;
  onAcknowledge: (operationId?: string) => void;
  variant?: "menu" | "banner";
}) {
  const tWallet = useTranslations("wallet");
  const hint = tWallet("signingRecoveryHint", {
    operation: tWallet(WALLET_SIGNING_OPERATION_MESSAGE_KEYS[record.operationKind]),
  });

  if (variant === "banner") {
    return (
      <div className="mx-auto mt-2 max-w-[1200px] px-4 sm:px-6 lg:px-8">
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/40 bg-pv-surface/95 px-4 py-3 text-[12px] shadow-[0_12px_36px_-14px_rgba(251,191,36,0.25)] backdrop-blur-xl"
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
              {tWallet("signingRecoveryTitle")}
            </p>
            <p className="mt-0.5 leading-relaxed text-pv-muted">{hint}</p>
          </div>
          <button
            type="button"
            onClick={() => onAcknowledge(record.operationId)}
            className="btn-compact-primary shrink-0 px-3.5 py-1.5 text-[12px]"
          >
            {tWallet("signingRecoveryAcknowledge")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="mb-1 rounded-xl border border-amber-400/35 bg-amber-400/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-pv-text"
    >
      <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
        {tWallet("signingRecoveryTitle")}
      </p>
      <p className="mt-1 text-pv-muted">{hint}</p>
      <button
        type="button"
        onClick={() => onAcknowledge(record.operationId)}
        className="btn-compact-primary mt-2.5 px-3 py-1 text-[11px]"
      >
        {tWallet("signingRecoveryAcknowledge")}
      </button>
    </div>
  );
}

function WalletAccountMenu({
  address,
  networkWarning,
  signingBlockedByOtherTab,
  signingRecovery,
  onAcknowledgeSigningRecovery,
  open,
  onOpenChange,
  onDisconnect,
  containerRef,
  buttonClassName,
}: {
  address: string;
  /**
   * Set when the connected wallet reports a different Stellar network than the
   * one Mimir submits to.
   *
   * Shown here rather than as a page banner with a "switch network" button,
   * because there is no button to offer: Stellar wallets have no equivalent of an
   * EVM chain-switch request, so the fix is in the wallet's own UI. The wallet
   * menu is where someone goes to look at their wallet, which makes it the one
   * place this belongs.
   */
  networkWarning: string | null;
  signingBlockedByOtherTab: boolean;
  signingRecovery: WalletSigningOperationRecord | null;
  onAcknowledgeSigningRecovery: (operationId?: string) => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onDisconnect: () => void;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  buttonClassName: string;
}) {
  const t = useTranslations("header");
  const tWallet = useTranslations("wallet");
  const [copied, setCopied] = useState(false);
  const explorerHref = getExplorerAddressUrl(address);

  const actionItemClass =
    "group flex w-full items-center gap-3 rounded-xl border border-transparent px-3.5 py-3 text-left text-[13px] font-medium text-pv-text/82 transition-[background-color,border-color,color,transform] hover:border-pv-emerald/20 hover:bg-pv-emerald/[0.07] hover:text-pv-text";
  const iconClass =
    "h-4 w-4 shrink-0 text-pv-muted transition-colors group-hover:text-pv-emerald";

  async function handleCopyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${t("walletMenu")}: ${address}`}
        className={buttonClassName}
      >
        {/* The visual label shows the truncated address; screen readers get the
            full G… strkey via aria-label so the user can verify which wallet is
            connected without needing to expand the menu. */}
        <span aria-hidden>{shortenAddress(address)}</span>
        <span className="sr-only">{address}</span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-[calc(100%+4px)] z-[60] min-w-[240px] overflow-hidden rounded-2xl border border-pv-border/40 bg-pv-surface/95 p-2 shadow-[0_22px_60px_-20px_rgba(51,79,169,0.22)] backdrop-blur-xl"
          >
            <div className="mb-1 rounded-xl border border-pv-ink/[0.08] bg-pv-ink/[0.03] px-3.5 py-3">
              <p className="font-display text-[13px] font-bold tracking-tight text-pv-text">
                {shortenAddress(address)}
              </p>
              <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-pv-muted">
                {t("connectedWallet")}
              </p>
            </div>

            {networkWarning ? (
              <p
                role="alert"
                className="mb-1 rounded-xl border border-amber-400/35 bg-amber-400/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-200"
              >
                {networkWarning}
              </p>
            ) : null}

            {signingRecovery ? (
              <SigningRecoveryNotice
                record={signingRecovery}
                onAcknowledge={onAcknowledgeSigningRecovery}
                variant="menu"
              />
            ) : signingBlockedByOtherTab ? (
              <div
                role="status"
                aria-live="polite"
                className="mb-1 rounded-xl border border-amber-400/35 bg-amber-400/[0.06] px-3.5 py-2.5 text-[12px] leading-relaxed text-pv-muted"
              >
                <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  {tWallet("signingActiveOtherTabTitle")}
                </p>
                <p className="mt-1">{tWallet("signingActiveOtherTabHint")}</p>
              </div>
            ) : null}

            <button
              type="button"
              role="menuitem"
              onClick={handleCopyAddress}
              className={actionItemClass}
            >
              <Copy className={iconClass} aria-hidden />
              <span>{copied ? t("copiedAddress") : t("copyAddress")}</span>
            </button>
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
              onClick={() => onOpenChange(false)}
              className={`${actionItemClass} mt-1`}
            >
              <ExternalLink className={iconClass} aria-hidden />
              <span>{t("viewOnExplorer")}</span>
            </a>
            <div className="my-2 h-px bg-pv-ink/[0.08]" aria-hidden />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onDisconnect();
                onOpenChange(false);
              }}
              className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3.5 py-3 text-left text-[13px] font-medium text-pv-muted transition-[background-color,border-color,color] hover:border-pv-ink/[0.08] hover:bg-pv-ink/[0.04] hover:text-pv-text"
            >
              <LogOut
                className="h-4 w-4 shrink-0 text-pv-muted transition-colors group-hover:text-pv-text"
                aria-hidden
              />
              <span>{t("disconnect")}</span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export default function Header() {
  const {
    address,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    networkWarning,
    signingBlockedByOtherTab = false,
    signingRecovery = null,
    acknowledgeSigningRecovery,
  } = useWallet();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const walletMenuDesktopRef = useRef<HTMLDivElement>(null);
  const walletMenuMobileRef = useRef<HTMLDivElement>(null);

  // Track scroll position so the navbar can lift off the page once the user
  // scrolls past the hero. At the top it blends into the background; once
  // scrolled it floats as a glass pill.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const t = useTranslations("header");
  const tc = useTranslations("common");

  const isPresentationHome = pathname === "/";
  const xmtpNavEnabled = useMemo(() => isXmtpFeatureEnabled(), []);

  const NAV_ITEMS = useMemo(() => {
    const items: Array<{
      href: "/vs/create" | "/explorer" | "/dashboard" | "/messages" | "/stats" | "/agents" | "/baskets" | "/council" | "/revenue";
      label: string;
      accent: boolean;
      mobileLabel?: string;
    }> = [
      { href: "/vs/create", label: t("challenge"), accent: true },
      { href: "/explorer", label: t("explore"), accent: false },
      { href: "/dashboard", label: t("myVS"), accent: false },
      { href: "/council", label: "Council", accent: false },
      { href: "/agents", label: "Agents", accent: false },
      { href: "/baskets", label: "Baskets", accent: false },
      { href: "/stats", label: "Stats", accent: false },
      { href: "/revenue", label: "Revenue", accent: false },
    ];
    if (xmtpNavEnabled) {
      items.push({
        href: "/messages",
        label: t("messages"),
        accent: false,
        mobileLabel: t("messagesMobile"),
      });
    }
    return items;
  }, [t, xmtpNavEnabled]);

  useEffect(() => {
    if (!walletMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Node;
      if (
        walletMenuDesktopRef.current?.contains(el) ||
        walletMenuMobileRef.current?.contains(el)
      ) {
        return;
      }
      setWalletMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [walletMenuOpen]);

  useEffect(() => {
    if (!walletMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWalletMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [walletMenuOpen]);

  return (
    <header className="fixed left-0 right-0 top-0 z-50 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
      <div
        className={`flex h-14 w-full items-center justify-between px-4 transition-[background-color,border-color,box-shadow,transform,margin] duration-300 ease-out sm:px-6 ${
          scrolled || mobileOpen
            ? "mt-2 rounded-2xl border border-pv-border/40 bg-pv-surface/70 px-5 shadow-[0_10px_40px_-12px_rgba(51,79,169,0.18)] backdrop-blur-[18px] sm:mt-3"
            : "mt-0 rounded-none border border-transparent bg-transparent shadow-none backdrop-blur-0"
        }`}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span className="group font-display text-lg font-bold tracking-tight text-pv-text transition-colors duration-300 ease-in-out sm:text-xl">
            Mimir
            <span
              className="ml-[1px] inline-block origin-center leading-none text-pv-text transition-[color,transform] duration-300 ease-out will-change-transform group-hover:scale-[1.22] group-hover:-rotate-6 group-hover:text-pv-emerald"
              aria-hidden
            >
              .
            </span>
          </span>
        </Link>

        {isPresentationHome ? (
          <div className="flex items-center gap-4 sm:gap-5">
            <Link
              href="/docs"
              className="font-mono text-[12px] font-medium text-pv-text/75 transition-colors hover:text-pv-emerald focus-ring sm:text-[13px]"
            >
              Docs <span className="text-pv-emerald">&lt;/&gt;</span>
            </Link>
            <Link
              href="/explorer"
              className="btn-compact-primary px-4 py-1.5 text-[12px] focus-ring sm:text-[13px]"
            >
              {t("launchApp")}
            </Link>
            <ThemeToggle className="focus-ring" />
          </div>
        ) : (
          <>
            {/* Desktop nav */}
            <div className="hidden items-center gap-2 md:flex lg:gap-3">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`chip relative whitespace-nowrap text-[13px] transition-all ${
                      item.accent
                        ? "border-pv-emerald bg-pv-emerald font-bold text-white hover:brightness-110"
                        : isActive
                        ? "border-pv-ink/[0.32] bg-pv-ink/[0.06] text-pv-text"
                        : "text-pv-muted hover:border-pv-ink/[0.22] hover:text-pv-text"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}

              <ThemeToggle className="focus-ring" />

              {isConnected && address ? (
                <WalletAccountMenu
                  address={address}
                  networkWarning={networkWarning}
                  signingBlockedByOtherTab={signingBlockedByOtherTab}
                  signingRecovery={signingRecovery}
                  onAcknowledgeSigningRecovery={(opId) => {
                    acknowledgeSigningRecovery?.(opId);
                  }}
                  open={walletMenuOpen}
                  onOpenChange={setWalletMenuOpen}
                  onDisconnect={disconnect}
                  containerRef={walletMenuDesktopRef}
                  buttonClassName="chip font-mono text-[11px] text-pv-emerald border-pv-emerald/[0.25] focus-ring"
                />
              ) : (
                <button
                  type="button"
                  onClick={connect}
                  disabled={isConnecting}
                  aria-busy={isConnecting}
                  className="btn-compact-primary px-4 py-1.5 text-[13px] focus-ring"
                >
                  {isConnecting ? tc("loading") : tc("connect")}
                </button>
              )}
            </div>

            {/* Mobile */}
            <div className="flex items-center gap-2 md:hidden">
              <ThemeToggle className="focus-ring" />
              {isConnected && address ? (
                <WalletAccountMenu
                  address={address}
                  networkWarning={networkWarning}
                  signingBlockedByOtherTab={signingBlockedByOtherTab}
                  signingRecovery={signingRecovery}
                  onAcknowledgeSigningRecovery={(opId) => {
                    acknowledgeSigningRecovery?.(opId);
                  }}
                  open={walletMenuOpen}
                  onOpenChange={setWalletMenuOpen}
                  onDisconnect={disconnect}
                  containerRef={walletMenuMobileRef}
                  buttonClassName="chip font-mono text-[10px] text-pv-emerald border-pv-emerald/[0.25]"
                />
              ) : (
                <button
                  type="button"
                  onClick={connect}
                  disabled={isConnecting}
                  aria-busy={isConnecting}
                  className="btn-compact-primary px-3 py-1.5 text-[12px]"
                >
                  {isConnecting ? tc("loading") : tc("connect")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setMobileOpen(!mobileOpen)}
                className="rounded p-1.5 text-pv-muted transition-colors hover:text-pv-text"
                aria-expanded={mobileOpen}
                aria-label={mobileOpen ? t("closeMenu") : t("openMenu")}
              >
                {mobileOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>
          </>
        )}
      </div>
      </div>

      {!isPresentationHome && isConnected && address && signingRecovery ? (
        <SigningRecoveryNotice
          record={signingRecovery}
          onAcknowledge={(opId) => {
            acknowledgeSigningRecovery?.(opId);
          }}
          variant="banner"
        />
      ) : null}

      {/* Mobile sheet */}
      <AnimatePresence>
        {!isPresentationHome && mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-b border-pv-ink/[0.08] bg-pv-surface/95 backdrop-blur-xl md:hidden"
          >
            <LayoutGroup id="mobile-header-nav">
              <nav
                className="flex flex-col gap-0.5 px-5 py-3"
                aria-label={t("mobileNavAria")}
              >
                {NAV_ITEMS.map((item) => {
                  const isActive = pathname === item.href;
                  const label = item.accent
                    ? t("challengeMobile")
                    : item.mobileLabel ?? item.label;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      aria-current={isActive ? "page" : undefined}
                      className={`relative block overflow-hidden rounded-lg px-4 py-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/35 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-bg ${
                        isActive
                          ? "text-pv-text"
                          : "text-pv-muted hover:text-pv-text"
                      }`}
                    >
                      {isActive ? (
                        <motion.span
                          layoutId="mobile-nav-active-highlight"
                          className="absolute inset-0 rounded-lg border border-pv-emerald/[0.28] bg-pv-emerald/[0.1]"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                          initial={false}
                        />
                      ) : null}
                      <span className="relative z-10">{label}</span>
                    </Link>
                  );
                })}
              </nav>
            </LayoutGroup>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
