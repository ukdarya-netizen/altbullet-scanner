export type TelegramChatType =
  | "private"
  | "group"
  | "supergroup"
  | "channel"
  | "unknown";

export type CommandAccess = "public" | "subscriber" | "owner";

export interface TelegramCommandDefinition {
  command: string;
  aliases?: string[];
  access: CommandAccess;
  privateOnly?: boolean;
  menu?: { command: string; description: string };
}

export type TelegramKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

export type TelegramInlineKeyboard = Array<Array<TelegramKeyboardButton>>;

export const ALT_BULLET_WEBSITE_URL = "https://crypto-alt-bullet.replit.app/";

const _dashboardUrl = process.env.REPLIT_DOMAINS
  ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}`
  : null;

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  {
    command: "/start",
    aliases: ["/command1"],
    access: "public",
    menu: { command: "start", description: "Начать работу с ботом" },
  },
  {
    command: "/myid",
    aliases: ["/command2"],
    access: "public",
    menu: { command: "myid", description: "Показать Chat ID" },
  },
  {
    command: "/menu",
    access: "subscriber",
  },
  {
    command: "/daily",
    aliases: ["/command3"],
    access: "subscriber",
    menu: { command: "daily", description: "Дневной отчёт" },
  },
  {
    command: "/weekly",
    aliases: ["/command4"],
    access: "subscriber",
    menu: { command: "weekly", description: "Недельный отчёт" },
  },
  {
    command: "/monthly",
    aliases: ["/command5"],
    access: "subscriber",
    menu: { command: "monthly", description: "Месячный дайджест" },
  },
  {
    command: "/prices",
    aliases: ["/pricing"],
    access: "public",
    menu: { command: "prices", description: "Тарифы" },
  },
  {
    command: "/subscription",
    aliases: ["/sub", "/expiry"],
    access: "public",
    menu: {
      command: "subscription",
      description: "Статус и даты подписки",
    },
  },
  {
    command: "/unsubscribe",
    aliases: ["/stop"],
    access: "subscriber",
    privateOnly: true,
    menu: { command: "unsubscribe", description: "Отписаться от сигналов" },
  },
  {
    command: "/resetpassword",
    access: "public",
    menu: {
      command: "resetpassword",
      description: "Сбросить пароль Dashboard",
    },
  },
  { command: "/activate_test", access: "owner" },
  { command: "/addsub", access: "owner" },
  { command: "/removesub", access: "owner" },
  { command: "/listsubs", access: "owner" },
  { command: "/addsignal", access: "owner" },
];

export const TELEGRAM_BOT_MENU = TELEGRAM_COMMANDS.flatMap((definition) =>
  definition.menu ? [definition.menu] : [],
);

export interface ParsedTelegramCommand {
  command: string;
  args: string[];
}

export function parseTelegramCommand(
  text: string | undefined,
): ParsedTelegramCommand | null {
  const tokens = text?.trim().split(/\s+/) ?? [];
  const token = tokens[0]?.toLowerCase();
  if (!token?.startsWith("/")) return null;

  const command = token.split("@")[0];
  if (!command || command === "/") return null;
  return { command, args: tokens.slice(1) };
}

export function getTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") return null;
  const updateId = (update as { update_id?: unknown }).update_id;
  return typeof updateId === "number" && Number.isSafeInteger(updateId)
    ? updateId
    : null;
}

export function findTelegramCommand(
  command: string,
): TelegramCommandDefinition | undefined {
  return TELEGRAM_COMMANDS.find(
    (definition) =>
      definition.command === command ||
      definition.aliases?.includes(command) === true,
  );
}

export function isPublicSetupCommand(text: string | undefined): boolean {
  const parsed = parseTelegramCommand(text);
  if (!parsed) return false;
  const command = findTelegramCommand(parsed.command)?.command;
  return command === "/start" || command === "/myid" || command === "/prices";
}

export function canReclaimTelegramUpdate(
  status: string | undefined,
  receivedAt: Date | undefined,
  now = new Date(),
): boolean {
  if (status === "failed") return true;
  if (status !== "processing" || !receivedAt) return false;
  return receivedAt.getTime() < now.getTime() - 5 * 60_000;
}

export type CommandAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "subscription" | "owner" | "private_chat" };

export function checkTelegramCommandAccess(
  definition: TelegramCommandDefinition,
  context: {
    isOwner: boolean;
    isSubscriber: boolean;
    chatType: TelegramChatType;
  },
): CommandAccessDecision {
  if (definition.privateOnly && context.chatType !== "private") {
    return { allowed: false, reason: "private_chat" };
  }
  if (definition.access === "public") return { allowed: true };
  if (definition.access === "owner") {
    return context.isOwner
      ? { allowed: true }
      : { allowed: false, reason: "owner" };
  }
  return context.isOwner || context.isSubscriber
    ? { allowed: true }
    : { allowed: false, reason: "subscription" };
}

export const TELEGRAM_CALLBACKS = [
  "subscription_status",
  "unsubscribe_confirm",
  "unsubscribe_yes",
  "unsubscribe_no",
] as const;

export type TelegramCallback = (typeof TELEGRAM_CALLBACKS)[number];

export function isTelegramCallback(data: string): boolean {
  return (
    (TELEGRAM_CALLBACKS as readonly string[]).includes(data) ||
    data.startsWith("approve_user:") ||
    data.startsWith("block_user:")
  );
}

export const SUBSCRIPTION_STATUS_KEYBOARD: TelegramInlineKeyboard = [
  [
    {
      text: "📅 Дата окончания подписки",
      callback_data: "subscription_status",
    },
  ],
];

export const SUBSCRIBER_MENU_KEYBOARD: TelegramInlineKeyboard = [
  ...SUBSCRIPTION_STATUS_KEYBOARD,
];

export const WELCOME_KEYBOARD: TelegramInlineKeyboard = [
  ...(_dashboardUrl
    ? [
        [
          {
            text: "📱 Открыть AltBullet",
            web_app: { url: _dashboardUrl },
          },
        ],
      ]
    : []),
  [{ text: "🌐 Открыть сайт", url: ALT_BULLET_WEBSITE_URL }],
  ...SUBSCRIPTION_STATUS_KEYBOARD,
];
