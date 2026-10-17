"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import '@/lib/i18n';
import { useTranslation } from "react-i18next";
import { resolveAuthenticatedPublicKey } from "@/lib/publicKey";
import { MerchantPaymentPreferencesPanel } from "@/components/settings/MerchantPaymentPreferencesPanel";
import {
  fetchProfileSettings,
  ProfileSettingsRequestError,
  saveProfileSettings,
} from "@/hooks/profileSettingsApi";

export default function Settings() {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    username: "",
    primaryColor: "#6366f1",
    avatarUrl: "",
    bio: "",
    twitterHandle: "",
    discordHandle: "",
    githubHandle: "",
  });

  const [showPreview, setShowPreview] = useState(false);
  const [walletPublicKey, setWalletPublicKey] = useState<string | null>(null);
  const [profileVersion, setProfileVersion] = useState(0);
  const [profileLoading, setProfileLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [reloadProfile, setReloadProfile] = useState(0);

  useEffect(() => {
    const publicKey = resolveAuthenticatedPublicKey();
    if (!publicKey) {
      setProfileError("Connect the wallet that owns a QuickEx username to edit its profile.");
      setProfileLoading(false);
      return;
    }

    let active = true;
    setWalletPublicKey(publicKey);
    setProfileLoading(true);
    setProfileError(null);
    void fetchProfileSettings(publicKey)
      .then((profiles) => {
        if (!active) return;
        const profile = profiles[0];
        if (!profile) {
          setProfileError("This wallet has no QuickEx username yet.");
          return;
        }
        setForm({
          username: profile.username,
          primaryColor: profile.primaryColor,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          twitterHandle: profile.twitterHandle,
          discordHandle: profile.discordHandle,
          githubHandle: profile.githubHandle,
        });
        setProfileVersion(profile.profileVersion);
      })
      .catch((err: unknown) => {
        if (active) {
          setProfileError(err instanceof Error ? err.message : "Unable to load profile settings.");
        }
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadProfile]);

  const profileReady = Boolean(walletPublicKey && form.username && profileVersion > 0);

  const handleSave = async () => {
    setSaveError(null);
    setSaveMessage(null);
    if (!profileReady || !walletPublicKey) {
      setSaveError("Load a wallet-owned username before saving profile settings.");
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(form.primaryColor)) {
      setSaveError("Primary color must be a six-digit hex color.");
      return;
    }
    if (form.avatarUrl && (!/^https:\/\//i.test(form.avatarUrl) || form.avatarUrl.length > 2048)) {
      setSaveError("Avatar URL must use HTTPS and be no longer than 2048 characters.");
      return;
    }
    if (
      form.bio.length > 160 ||
      form.twitterHandle.length > 15 ||
      !/^[A-Za-z0-9_]*$/.test(form.twitterHandle) ||
      form.discordHandle.length > 32 ||
      !/^[A-Za-z0-9-]*$/.test(form.discordHandle) ||
      form.githubHandle.length > 39 ||
      !/^[A-Za-z0-9-]*$/.test(form.githubHandle)
    ) {
      setSaveError("Check the bio and social handle length or format.");
      return;
    }

    setIsSaving(true);
    try {
      const profile = await saveProfileSettings({
        ...form,
        publicKey: walletPublicKey,
        profileVersion,
      });
      setProfileVersion(profile.profileVersion);
      setSaveMessage("Profile settings saved.");
    } catch (err: unknown) {
      if (err instanceof ProfileSettingsRequestError && err.status === 409) {
        setSaveError("This profile changed in another session. Reload the latest version before saving.");
      } else {
        setSaveError(err instanceof Error ? err.message : "Unable to save profile settings.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="relative min-h-screen text-foreground selection:bg-indigo-500/30">
      <NetworkBadge />

      {/* Background glows */}
      <div className="fixed top-[-20%] left-[-30%] w-[60%] h-[60%] bg-indigo-500/10 blur-[120px] rounded-full" />
      <div className="fixed bottom-[-20%] right-[-30%] w-[50%] h-[50%] bg-purple-500/5 blur-[100px] rounded-full" />

      {/* MOBILE HEADER */}
      <div className="md:hidden relative z-10 p-4 border-b border-border bg-card backdrop-blur-3xl">
        <div className="flex items-center justify-between">
          <Link
            href="/dashboard"
            className="text-subtle hover:text-foreground transition"
          >
            ← Back
          </Link>
          <h1 className="text-lg font-black">{t('settingsTitle')}</h1>
          <div className="w-16" /> {/* Spacer for centering */}
        </div>
      </div>

      {/* DESKTOP SIDEBAR */}
      <aside className="hidden md:flex w-72 h-screen fixed left-0 top-0 border-r border-border bg-card backdrop-blur-3xl flex-col z-20">
        <nav className="flex-1 px-4 py-30 space-y-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-4 py-3 text-subtle hover:text-foreground hover:bg-surface rounded-2xl font-semibold transition"
          >
            <span>📊</span> Dashboard
          </Link>
          <Link
            href="/generator"
            className="flex items-center gap-3 px-4 py-3 text-subtle hover:text-foreground hover:bg-surface rounded-2xl font-semibold transition"
          >
            <span>⚡</span> Link Generator
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-2xl font-bold"
          >
            <span className="text-indigo-400">⚙️</span> Profile Settings
          </Link>
          <Link
            href="/settings/teams"
            className="flex items-center gap-3 px-4 py-3 text-subtle hover:text-foreground hover:bg-surface rounded-2xl font-semibold transition"
          >
            <span>👥</span> Team Management
          </Link>
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <main className="relative z-10 p-4 sm:p-6 md:p-12 md:ml-72 pb-24 md:pb-12">
        {/* Header - Hidden on mobile, shown on desktop */}
        <header className="hidden md:block mb-10">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight mb-2">
            {t('profileCustomization')}
          </h1>
          <p className="text-subtle font-medium text-sm sm:text-base">
            {t('profileCustomizationDescription', { username: form.username })}
          </p>
        </header>

        {/* Mobile subheader */}
        <div className="md:hidden mb-6">
          <p className="text-subtle text-sm">
            {t('profileCustomizationDescription', { username: form.username })}
          </p>
        </div>

        <nav className="flex gap-3 mb-8">
          <Link
            href="/settings"
            className="px-4 py-2 rounded-xl border border-border-strong bg-surface-strong text-sm font-semibold hover:bg-surface-strong"
          >
            {t('generalTab')}
          </Link>
          <Link
            href="/settings/teams"
            className="px-4 py-2 rounded-xl border border-border-strong text-sm font-semibold hover:bg-surface"
          >
            Team
          </Link>
          <Link
            href="/settings/developer"
            className="px-4 py-2 rounded-xl border border-border-strong text-sm font-semibold hover:bg-surface"
          >
            {t('developerTab')}
          </Link>
        </nav>

        {profileLoading ? (
          <p role="status" className="mb-4 text-sm text-muted">Loading profile settings...</p>
        ) : null}
        {profileError ? (
          <div role="alert" className="mb-4 border-l-4 border-amber-500 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
            {profileError}
          </div>
        ) : null}
        {saveError ? (
          <div role="alert" className="mb-4 border-l-4 border-red-500 bg-red-500/10 px-4 py-3 text-sm text-foreground">
            <p>{saveError}</p>
            {saveError.includes("another session") ? (
              <button
                type="button"
                onClick={() => setReloadProfile((current) => current + 1)}
                className="mt-2 font-semibold underline"
              >
                Reload latest profile
              </button>
            ) : null}
          </div>
        ) : null}
        {saveMessage ? (
          <p role="status" className="mb-4 text-sm font-semibold text-success">{saveMessage}</p>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 lg:gap-8">
          {/* Settings Form */}
          <div className="space-y-4 sm:space-y-6">
            {/* Theme Settings Card */}
            <div className="rounded-2xl sm:rounded-3xl bg-card border border-border p-5 sm:p-6 md:p-8">
              <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6">
                {t('themeSettings')}
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('primaryColor')}
                  </label>
                  <div className="flex gap-2 sm:gap-3">
                    <input
                      type="color"
                      value={form.primaryColor}
                      onChange={(e) =>
                        setForm({ ...form, primaryColor: e.target.value })
                      }
                      className="w-14 sm:w-16 h-11 sm:h-12 rounded-xl border border-border-strong bg-transparent cursor-pointer"
                    />
                    <input
                      type="text"
                      value={form.primaryColor}
                      onChange={(e) =>
                        setForm({ ...form, primaryColor: e.target.value })
                      }
                      className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground font-mono text-sm sm:text-base"
                      placeholder="#6366f1"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('avatarUrl')}
                  </label>
                  <input
                    type="url"
                    value={form.avatarUrl}
                    onChange={(e) =>
                      setForm({ ...form, avatarUrl: e.target.value })
                    }
                    className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground text-sm sm:text-base"
                    placeholder="https://example.com/avatar.jpg"
                  />
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('bioLabel')}
                  </label>
                  <textarea
                    value={form.bio}
                    onChange={(e) => setForm({ ...form, bio: e.target.value })}
                    maxLength={160}
                    rows={3}
                    className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground resize-none text-sm sm:text-base"
                    placeholder="Building the future of payments on Stellar"
                  />
                  <p className="text-xs text-faint mt-1">
                    {form.bio.length}/160 characters
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl sm:rounded-3xl bg-card border border-border p-5 sm:p-6 md:p-8">
              <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6">
                {t('languageLabel')}
              </h2>
              <p className="text-sm text-subtle mb-4">
                {t('changeLanguage')}
              </p>
              <LocaleSwitcher />
            </div>

            {/* Social Links Card */}
            <div className="rounded-2xl sm:rounded-3xl bg-card border border-border p-5 sm:p-6 md:p-8">
              <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6">
                Social Links
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('twitterHandleLabel')}
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-subtle text-sm sm:text-base">
                      @
                    </span>
                    <input
                      type="text"
                      value={form.twitterHandle}
                      onChange={(e) =>
                        setForm({ ...form, twitterHandle: e.target.value })
                      }
                      className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground text-sm sm:text-base"
                      placeholder="stellarorg"
                      maxLength={15}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('discordUsernameLabel')}
                  </label>
                  <input
                    type="text"
                    value={form.discordHandle}
                    onChange={(e) =>
                      setForm({ ...form, discordHandle: e.target.value })
                    }
                    className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground text-sm sm:text-base"
                    placeholder="user#1234"
                    maxLength={32}
                  />
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-bold text-subtle mb-2">
                    {t('githubHandleLabel')}
                  </label>
                  <input
                    type="text"
                    value={form.githubHandle}
                    onChange={(e) =>
                      setForm({ ...form, githubHandle: e.target.value })
                    }
                    className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-surface border border-border-strong text-foreground text-sm sm:text-base"
                    placeholder="stellar"
                    maxLength={39}
                  />
                </div>
              </div>
            </div>

            {/* Action Buttons - Desktop */}
            <div className="hidden sm:flex gap-3 sm:gap-4">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!profileReady || profileLoading || isSaving}
                className="flex-1 px-4 sm:px-6 py-3 sm:py-4 bg-indigo-500 text-white font-bold rounded-xl hover:scale-105 active:scale-95 transition text-sm sm:text-base"
              >
                {isSaving ? "Saving..." : t('saveChanges')}
              </button>
              <button
                onClick={() => setShowPreview(!showPreview)}
                className="px-4 sm:px-6 py-3 sm:py-4 bg-surface border border-border-strong text-foreground font-bold rounded-xl hover:bg-surface-strong transition text-sm sm:text-base whitespace-nowrap"
              >
                {showPreview ? t('hide') : t('show')} {t('preview')}
              </button>
            </div>
          </div>

          {/* Live Preview - Desktop */}
          {showPreview && (
            <div className="hidden lg:block lg:sticky lg:top-12 h-fit">
              <div className="rounded-3xl bg-card border border-border p-8">
                <h2 className="text-xl font-bold mb-6">{t('livePreview')}</h2>
                <div className="rounded-2xl border border-border-strong overflow-hidden bg-background">
                  <ProfilePreview {...form} />
                </div>
              </div>
            </div>
          )}

          {/* Live Preview - Mobile/Tablet (when toggled) */}
          {showPreview && (
            <div className="lg:hidden rounded-2xl sm:rounded-3xl bg-card border border-border p-5 sm:p-6 md:p-8">
              <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6">
                {t('livePreview')}
              </h2>
              <div className="rounded-2xl border border-border-strong overflow-hidden bg-background">
                <ProfilePreview {...form} />
              </div>
            </div>
          )}
        </div>
        <MerchantPaymentPreferencesPanel initialPublicKey={walletPublicKey} />
      </main>

      {/* MOBILE BOTTOM BAR */}
      <div className="sm:hidden fixed bottom-0 left-0 right-0 z-30 p-4 bg-card backdrop-blur-3xl border-t border-border">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!profileReady || profileLoading || isSaving}
            className="flex-1 px-4 py-3 bg-indigo-500 text-white font-bold rounded-xl active:scale-95 transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? "Saving..." : t('saveChanges')}
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="px-4 py-3 bg-surface border border-border-strong text-foreground font-bold rounded-xl active:scale-95 transition"
          >
            {showPreview ? t('hide') : t('show')} {t('preview')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfilePreview({
  username,
  primaryColor,
  avatarUrl,
  bio,
  twitterHandle,
  discordHandle,
  githubHandle,
}: {
  username: string;
  primaryColor: string;
  avatarUrl: string;
  bio: string;
  twitterHandle: string;
  discordHandle: string;
  githubHandle: string;
}) {
  return (
    <div className="p-6 sm:p-8 text-center">
      {/* Avatar */}
      <div className="flex justify-center mb-4 sm:mb-6">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={username}
            width={96}
            height={96}
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border-4 object-cover"
            style={{ borderColor: primaryColor }}
          />
        ) : (
          <div
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border-4 flex items-center justify-center text-2xl sm:text-3xl font-black"
            style={{ borderColor: primaryColor, color: primaryColor }}
          >
            {username[0]?.toUpperCase()}
          </div>
        )}
      </div>

      {/* Username */}
      <h1 className="text-xl sm:text-2xl font-black mb-2">@{username}</h1>

      {/* Bio */}
      {bio && (
        <p className="text-subtle text-xs sm:text-sm mb-4 sm:mb-6 px-2">
          {bio}
        </p>
      )}

      {/* Social Links */}
      {(twitterHandle || discordHandle || githubHandle) && (
        <div className="flex justify-center gap-2 sm:gap-3 mb-4 sm:mb-6">
          {twitterHandle && (
            <a
              href={`https://twitter.com/${twitterHandle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-surface hover:bg-surface-strong flex items-center justify-center transition text-sm sm:text-base"
              style={{ color: primaryColor }}
            >
              𝕏
            </a>
          )}
          {discordHandle && (
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-surface flex items-center justify-center text-sm sm:text-base"
              style={{ color: primaryColor }}
            >
              💬
            </div>
          )}
          {githubHandle && (
            <a
              href={`https://github.com/${githubHandle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-surface hover:bg-surface-strong flex items-center justify-center transition text-sm sm:text-base"
              style={{ color: primaryColor }}
            >
              🐙
            </a>
          )}
        </div>
      )}

      {/* Payment Button */}
      <button
        className="w-full py-3 sm:py-4 rounded-xl font-bold text-foreground transition hover:opacity-90 text-sm sm:text-base"
        style={{ backgroundColor: primaryColor }}
      >
        Send Payment
      </button>
    </div>
  );
}
