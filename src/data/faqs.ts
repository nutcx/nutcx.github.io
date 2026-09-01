export type FaqCategory =
  | "About"
  | "Compatibility"
  | "Access setup"
  | "Resources"
  | "Installing"
  | "Privacy and notifications";

export interface SupportFaq {
  readonly id: string;
  readonly category: FaqCategory;
  readonly question: string;
  readonly answer: string;
  readonly keywords: readonly string[];
}

export const supportFaqs: readonly SupportFaq[] = [
  {
    id: "what-is-nutcracker-tools",
    category: "About",
    question: "What is NutCracker Tools?",
    answer:
      "NutCracker Tools is an Android hero companion and resource utility. It brings hero profiles, skills, combos, matchup information, skin previews, preparation resources, local ZIP inspection, and install history into one app.",
    keywords: ["about", "heroes", "skins", "preparation"],
  },
  {
    id: "official-package-name",
    category: "About",
    question: "What is the NutCracker Tools Android package name?",
    answer:
      "The NutCracker Tools app package is com.nutcx.tools. The target game package is configured separately inside Storage & access settings.",
    keywords: ["package", "com.nutcx.tools", "app id"],
  },
  {
    id: "account-required",
    category: "About",
    question: "Do I need an account to use NutCracker Tools?",
    answer:
      "No. The current Android app does not create or maintain user accounts. App preferences, Favorites, access settings, and install records are stored for the app on the device.",
    keywords: ["account", "login", "sign up", "local data"],
  },
  {
    id: "android-compatibility",
    category: "Compatibility",
    question: "Which Android versions are supported?",
    answer:
      "The current app build supports Android 8.0 and later. Access options differ by version: Direct storage is limited to Android 10 and earlier, while ADB is the advanced route intended for Android 11 and later when folder access is unavailable.",
    keywords: ["android", "version", "android 8", "android 10", "android 11"],
  },
  {
    id: "choose-target-package",
    category: "Compatibility",
    question: "Why does NutCracker Tools ask for a target package?",
    answer:
      "The target package tells NutCracker Tools which Android/data folder it may update. The default is com.mobile.legends. Only choose a different package when the resource you plan to apply was built for it.",
    keywords: ["target package", "com.mobile.legends", "android data"],
  },
  {
    id: "choose-access-method",
    category: "Access setup",
    question: "Which access method should I choose?",
    answer:
      "Try Folder access first when Android lets you select the matching package folder. Use Direct storage on Android 10 or earlier. On Android 11 or later, use the advanced ADB setup when the folder picker is unavailable or blocks the selected package.",
    keywords: ["folder access", "direct storage", "adb", "recommended"],
  },
  {
    id: "folder-access-steps",
    category: "Access setup",
    question: "How do I grant Folder access?",
    answer:
      "Choose the target package, open Folder access, select the matching folder under Android/data, tap “Use this folder,” and allow NutCracker Tools to remember the grant. The app reports when access is ready for that package.",
    keywords: ["folder", "permission", "use this folder", "storage"],
  },
  {
    id: "adb-requirements",
    category: "Access setup",
    question: "What does the ADB setup require?",
    answer:
      "Keep the device on Wi-Fi, enable Developer options and Wireless debugging, open “Pair device with pairing code,” and enter the current six-digit code through the NutCracker Tools notification. Keep the Android pairing dialog open until the code is accepted and a live ADB connection is verified.",
    keywords: ["adb", "wireless debugging", "developer options", "pairing code", "wifi"],
  },
  {
    id: "adb-notification-permission",
    category: "Access setup",
    question: "Why does ADB setup need notification permission?",
    answer:
      "On Android 13 and later, notifications must be allowed so NutCracker Tools can show the pairing-code input notification. Without it, the built-in Wireless debugging flow cannot receive the six-digit code.",
    keywords: ["notifications", "android 13", "adb", "pairing"],
  },
  {
    id: "adb-connection-not-found",
    category: "Access setup",
    question: "What should I do if the ADB connection is not found?",
    answer:
      "Keep Android's Wireless debugging screen open, confirm Wi-Fi and Wireless debugging are still enabled, then return to NutCracker Tools and retry the connection. If the pairing code expired or was rejected, create a fresh code and pair again.",
    keywords: ["adb", "connection", "timeout", "expired code", "retry"],
  },
  {
    id: "search-resources",
    category: "Resources",
    question: "What can I search for?",
    answer:
      "Global search finds skins and preparation resources by skin, hero, or item name. Results can be filtered to All, Skins, Preparations, or Favorites, with extra skin filters for Backup, Replacement, Official, Custom, and Anime resources.",
    keywords: ["search", "filters", "skins", "preparation", "favorites"],
  },
  {
    id: "favorites-storage",
    category: "Resources",
    question: "Where are my Favorites saved?",
    answer:
      "Favorites are saved locally in NutCracker Tools on the current device. Star a skin or preparation resource to include it in the Favorites filter.",
    keywords: ["favorites", "saved", "local", "device"],
  },
  {
    id: "supported-local-zip",
    category: "Installing",
    question: "What kind of ZIP can the local Installer apply?",
    answer:
      "Choose a valid ZIP containing supported game resource paths. Before applying it, NutCracker Tools reports recognized files under Art, Audio, UI, and Document, shows ignored files, and rejects an archive with no supported content or conflicting output paths.",
    keywords: ["zip", "installer", "art", "audio", "ui", "document"],
  },
  {
    id: "apply-unavailable",
    category: "Installing",
    question: "Why is Apply unavailable?",
    answer:
      "Apply can be unavailable when the resource has no download archive, the target package or access method is not ready, another install is active, or a remote resource needs an internet connection. Resolve the shown status before trying again.",
    keywords: ["apply", "unavailable", "busy", "internet", "access"],
  },
  {
    id: "install-progress",
    category: "Installing",
    question: "Can I follow an install after it starts?",
    answer:
      "Yes. NutCracker Tools shows an active install banner and a detail view with progress and an activity log. It reports downloading, inspection, original-file lookup, file writing, completion, cancellation, failure, and recovery states.",
    keywords: ["progress", "activity log", "install", "notification"],
  },
  {
    id: "restore-originals",
    category: "Installing",
    question: "Can NutCracker Tools restore original files?",
    answer:
      "A recorded install can offer Restore originals. NutCracker Tools restores originals from the install's known download sources and removes applied files when no original is available. The history entry is removed only after the restore succeeds.",
    keywords: ["restore", "original", "history", "remove"],
  },
  {
    id: "interrupted-install",
    category: "Installing",
    question: "What happens if an install is interrupted?",
    answer:
      "NutCracker Tools journals file changes so it can roll back to previous files. If recovery cannot finish immediately, the app marks recovery as pending and asks you to reconnect the original access method before it continues.",
    keywords: ["interrupted", "rollback", "recovery", "previous files"],
  },
  {
    id: "internet-requirements",
    category: "Resources",
    question: "Does NutCracker Tools require an internet connection?",
    answer:
      "Hero and content updates and remote resource downloads require a connection. A ZIP already on the device can be selected and inspected locally, but applying it still requires a configured access method and any network resources needed by that operation.",
    keywords: ["internet", "offline", "download", "local zip"],
  },
  {
    id: "advertising-and-consent",
    category: "Privacy and notifications",
    question: "Does NutCracker Tools show ads?",
    answer:
      "NutCracker Tools can show an ad inside the Dashboard. Ads are requested only after Google's consent flow allows them, and regional ad privacy choices can be reviewed from Settings when that option is available.",
    keywords: ["ads", "advertising", "consent", "privacy"],
  },
  {
    id: "notification-controls",
    category: "Privacy and notifications",
    question: "Can I choose which updates notify me?",
    answer:
      "Yes. Settings includes controls for NutCracker Tools announcements, content updates, and important service or compatibility notices. ADB pairing and active install notifications are separate operational notifications used by those features.",
    keywords: ["notifications", "announcements", "content updates", "important notices"],
  },
];

export const faqCategories: readonly FaqCategory[] = [
  "About",
  "Compatibility",
  "Access setup",
  "Resources",
  "Installing",
  "Privacy and notifications",
];

export const faqs = supportFaqs;
