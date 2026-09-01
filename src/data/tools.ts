export const NUTCRACKER_ANDROID_PACKAGE = "com.nutcx.tools" as const;

export type DashboardToolId =
  | "hero-explorer"
  | "matchup-guide"
  | "skin-library"
  | "preparation-catalog"
  | "zip-installer"
  | "install-history";

export type ToolIconKey =
  | "guide"
  | "activity"
  | "spark"
  | "tools"
  | "install"
  | "history";

export interface DashboardTool {
  readonly id: DashboardToolId;
  readonly title: string;
  readonly eyebrow: string;
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly icon: ToolIconKey;
}

export const dashboardTools: readonly DashboardTool[] = [
  {
    id: "hero-explorer",
    title: "Hero Explorer",
    eyebrow: "Heroes",
    summary:
      "Browse the roster by role and lane, then open a focused profile for each hero.",
    highlights: [
      "Tank, Fighter, Assassin, Mage, Marksman, and Support filters",
      "EXP, Jungle, Mid, Gold, and Roam lane filters",
      "Profile, specialty, lane, and performance stats",
    ],
    icon: "guide",
  },
  {
    id: "matchup-guide",
    title: "Matchup Guide",
    eyebrow: "Game knowledge",
    summary:
      "Review skills, practical combos, counters, compatibility, and hero relationships before a match.",
    highlights: [
      "Skill groups and combo sequences",
      "Best counters and most-countered-by views",
      "Strong, weak, and team-compatible relationships",
    ],
    icon: "activity",
  },
  {
    id: "skin-library",
    title: "Skin Library",
    eyebrow: "Preview and apply",
    summary:
      "Compare available looks and replacements for a hero before starting an install.",
    highlights: [
      "Official, anime, and custom categories",
      "Current-versus-replacement previews",
      "Install availability and progress states",
    ],
    icon: "spark",
  },
  {
    id: "preparation-catalog",
    title: "Preparation Catalog",
    eyebrow: "Battle effects",
    summary:
      "Browse backup and replacement resources for preparation effects and apply a selected option.",
    highlights: [
      "Emote, Recall, Spawn, and Elimination",
      "Notification and Trail resources",
      "Backup and replacement choices",
    ],
    icon: "tools",
  },
  {
    id: "zip-installer",
    title: "Local ZIP Installer",
    eyebrow: "From your device",
    summary:
      "Choose a ZIP you already have, inspect its supported content, and review the target before applying it.",
    highlights: [
      "Art, Audio, UI, and Document resource roots",
      "Included and ignored file counts",
      "Package, access method, and activity review",
    ],
    icon: "install",
  },
  {
    id: "install-history",
    title: "Install History",
    eyebrow: "Recovery",
    summary:
      "Follow completed, failed, and cancelled installs and restore original files when a recorded install supports it.",
    highlights: [
      "Result, time, and processed-file details",
      "Original-file restoration",
      "Interrupted-install rollback and recovery states",
    ],
    icon: "history",
  },
];

export type SetupMethodId =
  | "folder-access"
  | "direct-storage"
  | "wireless-adb";

export interface SetupRecommendation {
  readonly id: SetupMethodId;
  readonly title: string;
  readonly label: string;
  readonly recommendedFor: string;
  readonly description: string;
  readonly requirements: readonly string[];
}

export const setupRecommendations: readonly SetupRecommendation[] = [
  {
    id: "folder-access",
    title: "Folder access",
    label: "Guided setup",
    recommendedFor:
      "The first setup attempt when Android lets you select the target package folder.",
    description:
      "NutCracker Tools opens Android's folder picker at Android/data/{package name}. Select the matching package folder, choose “Use this folder,” and allow the app to remember the grant.",
    requirements: [
      "A target package selected in NutCracker Tools",
      "Permission to retain Android's folder-picker grant",
    ],
  },
  {
    id: "direct-storage",
    title: "Direct storage",
    label: "Android 10 and earlier",
    recommendedFor:
      "Devices running Android 10 or earlier that support legacy read and write storage access.",
    description:
      "This legacy path writes through Android's storage permissions and is unavailable on newer Android versions.",
    requirements: [
      "Android 10 or earlier",
      "Read and write storage permission",
    ],
  },
  {
    id: "wireless-adb",
    title: "ADB",
    label: "Advanced setup",
    recommendedFor:
      "Android 11 and later when the folder picker is unavailable or blocks the selected package.",
    description:
      "Pair NutCracker Tools with Android's Wireless debugging, verify a live local ADB connection, then grant folder access for the selected package.",
    requirements: [
      "Wi-Fi, Developer options, and Wireless debugging enabled",
      "A current six-digit Wireless debugging pairing code",
      "Notifications allowed on Android 13 and later for pairing-code input",
    ],
  },
];

export type ProductFeatureId =
  | "featured-dashboard"
  | "global-search"
  | "local-favorites"
  | "install-progress"
  | "safe-recovery"
  | "notification-controls"
  | "theme-controls";

export interface ProductFeature {
  readonly id: ProductFeatureId;
  readonly title: string;
  readonly description: string;
}

export const productFeatures: readonly ProductFeature[] = [
  {
    id: "featured-dashboard",
    title: "One focused dashboard",
    description:
      "Featured heroes, hero stats and skills, guides, patch notes, and events share one home view.",
  },
  {
    id: "global-search",
    title: "Resource search",
    description:
      "Search skins and preparations by skin, hero, or item name, then narrow results by resource type.",
  },
  {
    id: "local-favorites",
    title: "On-device favorites",
    description:
      "Star skins and preparation resources so they remain available in a dedicated Favorites filter on that device.",
  },
  {
    id: "install-progress",
    title: "Visible install activity",
    description:
      "Open install details to follow download, inspection, file-writing, completion, cancellation, or failure states.",
  },
  {
    id: "safe-recovery",
    title: "Safer file changes",
    description:
      "Install transactions preserve previous files for rollback, and interrupted work can surface a recovery action instead of failing silently.",
  },
  {
    id: "notification-controls",
    title: "Notification controls",
    description:
      "Choose whether to receive announcements, content updates, and important compatibility notices.",
  },
  {
    id: "theme-controls",
    title: "Light, dark, or system theme",
    description:
      "Match NutCracker Tools to the device theme or keep a preferred appearance.",
  },
];

export type ResourceCategoryGroupId =
  | "skin-types"
  | "preparation-types"
  | "zip-resource-roots";

export interface ResourceCategory {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface ResourceCategoryGroup {
  readonly id: ResourceCategoryGroupId;
  readonly title: string;
  readonly description: string;
  readonly categories: readonly ResourceCategory[];
}

export const resourceCategories: readonly ResourceCategoryGroup[] = [
  {
    id: "skin-types",
    title: "Skin resources",
    description:
      "Filters used by the NutCracker Tools skin library and global resource search.",
    categories: [
      {
        id: "backup",
        label: "Backup",
        description: "Original-resource options used as a restore point.",
      },
      {
        id: "replacement",
        label: "Replacement",
        description: "An available look that can replace the selected source skin.",
      },
      {
        id: "official",
        label: "Official",
        description: "Official-style skin resources listed for a hero.",
      },
      {
        id: "anime",
        label: "Anime",
        description: "Anime-category skin resources listed for a hero.",
      },
      {
        id: "custom",
        label: "Custom",
        description: "Custom-category skin resources listed for a hero.",
      },
    ],
  },
  {
    id: "preparation-types",
    title: "Preparation resources",
    description:
      "Battle-effect categories available in the Preparation catalog.",
    categories: [
      { id: "emote", label: "Emote", description: "In-match emote resources." },
      { id: "recall", label: "Recall", description: "Recall-effect resources." },
      { id: "spawn", label: "Spawn", description: "Spawn-effect resources." },
      {
        id: "elimination",
        label: "Elimination",
        description: "Elimination-effect resources.",
      },
      {
        id: "notification",
        label: "Notification",
        description: "In-game notification-effect resources.",
      },
      { id: "trail", label: "Trail", description: "Trail-effect resources." },
    ],
  },
  {
    id: "zip-resource-roots",
    title: "Local ZIP content",
    description:
      "Supported top-level game resource groups reported during local archive inspection.",
    categories: [
      { id: "art", label: "Art", description: "Supported visual asset files." },
      { id: "audio", label: "Audio", description: "Supported audio asset files." },
      { id: "ui", label: "UI", description: "Supported interface asset files." },
      {
        id: "document",
        label: "Document",
        description: "Supported game resource and manifest files.",
      },
    ],
  },
];
