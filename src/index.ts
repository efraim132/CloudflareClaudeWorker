/**
 * Statuspage -> Discord Webhook Proxy (Cloudflare Worker)
 *
 * Receives Atlassian Statuspage webhooks (like from status.anthropic.com)
 * and reformats them into Discord-compatible embeds.
 *
 * The DISCORD_WEBHOOK_URL is stored as a secret, not hardcoded.
 * Set it with: npx wrangler secret put DISCORD_WEBHOOK_URL
 */

// ============================================================
// Types - so we know what shape the data is
// ============================================================

// This is the "Env" object that Cloudflare injects into every request.
// Any secrets or bindings you set up in wrangler.toml or via CLI show up here.
interface Env {
  DISCORD_WEBHOOK_URL: string;
  claudestatusdb: D1Database;
}

// Statuspage sends two types of payloads: incident and component.
// These interfaces cover both the old and new format fields.

interface StatuspageIncidentUpdate {
  update_id?: string;
  update_status?: string;
  update_message?: string;
  body?: string; // old format uses "body" instead of "update_message"
  status?: string; // old format uses "status" instead of "update_status"
}

interface StatuspageComponent {
  name: string;
  status: string;
  created_at?: string;
  id?: string;
}

interface StatuspageComponentUpdate {
  old_status: string;
  new_status: string;
  created_at?: string;
  id?: string;
  component_id?: string;
}

interface StatuspageIncident {
  name?: string; // old format
  incident_title?: string; // new format
  status?: string; // old format
  current_status?: string; // new format
  impact?: string;
  shortlink?: string;
  incident_updates?: StatuspageIncidentUpdate[]; // old format: array of updates
  current_update?: StatuspageIncidentUpdate; // new format: single current update
  current_affected_components?: StatuspageComponent[]; // new format only
}

interface StatuspagePage {
  id?: string;
  status_indicator?: string;
  status_description?: string;
}

interface StatuspageInfo {
  url?: string;
  id?: string;
  title?: string;
}

// The top-level payload shape
interface StatuspagePayload {
  meta?: Record<string, unknown>;
  page?: StatuspagePage;
  statuspage?: StatuspageInfo;
  incident?: StatuspageIncident;
  component?: StatuspageComponent;
  component_update?: StatuspageComponentUpdate;
}

// Discord embed structure
interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  url?: string;
}

// ============================================================
// Color map - decimal values for Discord embeds
// ============================================================

const COLORS: Record<string, number> = {
  // impact levels
  none: 0x2ecc71, // green
  minor: 0xf1c40f, // yellow
  major: 0xe67e22, // orange
  critical: 0xe74c3c, // red
  maintenance: 0x3498db, // blue

  // component statuses
  operational: 0x2ecc71,
  degraded_performance: 0xf1c40f,
  partial_outage: 0xe67e22,
  major_outage: 0xe74c3c,
  under_maintenance: 0x3498db,

  // incident statuses
  investigating: 0xe74c3c,
  identified: 0xe67e22,
  monitoring: 0xf1c40f,
  resolved: 0x2ecc71,
  scheduled: 0x3498db,
  in_progress: 0xe67e22,
  verifying: 0xf1c40f,
  completed: 0x2ecc71,
};

// Falls back to gray if status isn't in the map
function getColor(status: string): number {
  return COLORS[status] ?? 0x95a5a6;
}

// Takes "major_outage" and returns "Major Outage"
function prettify(text: string): string {
  return text
    .replace(/_/g, " ") // swap underscores for spaces
    .replace(/\b\w/g, (char) => char.toUpperCase()); // capitalize first letter of each word
}

// ============================================================
// Embed builders
// ============================================================

function buildIncidentEmbed(data: StatuspagePayload): DiscordEmbed {
  const incident = data.incident!;

  // New format uses "incident_title", old uses "name"
  const name = incident.incident_title || incident.name || "Unknown Incident";

  // New format uses "current_status", old uses "status"
  const status = incident.current_status || incident.status || "unknown";

  const impact = incident.impact || "none";

  // --- Get latest update message ---
  // New format puts it in "current_update.update_message"
  // Old format puts it in "incident_updates[0].body"
  let latestMessage = "";

  if (incident.current_update) {
    latestMessage = incident.current_update.update_message || "";
  }

  if (
    !latestMessage &&
    incident.incident_updates &&
    incident.incident_updates.length > 0
  ) {
    latestMessage = incident.incident_updates[0].body || "";
  }

  if (!latestMessage) {
    latestMessage = "No details provided.";
  }

  // --- Affected components (new format only) ---
  let componentText = "";
  if (
    incident.current_affected_components &&
    incident.current_affected_components.length > 0
  ) {
    componentText = incident.current_affected_components
      .map((c) => c.name) // pull out just the name from each component
      .join(", "); // "API, Dashboard, Auth"
  }

  // --- Page info for footer ---
  const pageName = data.statuspage?.title || data.page?.id || "Statuspage";
  const pageUrl = data.statuspage?.url || "";

  // --- Build the embed ---
  const embed: DiscordEmbed = {
    title: name,
    description: latestMessage,
    // If impact is "none", use the status color instead (e.g. "resolved" = green)
    color: getColor(impact !== "none" ? impact : status),
    fields: [
      { name: "Status", value: prettify(status), inline: true },
      { name: "Impact", value: prettify(impact), inline: true },
    ],
    footer: { text: pageName },
    timestamp: new Date().toISOString(),
  };

  if (componentText) {
    embed.fields!.push({
      name: "Affected Components",
      value: componentText,
      inline: false,
    });
  }

  // Link to the incident page if available
  if (incident.shortlink) {
    embed.url = incident.shortlink;
  } else if (pageUrl) {
    embed.url = pageUrl;
  }

  return embed;
}

function buildComponentEmbed(data: StatuspagePayload): DiscordEmbed {
  const component = data.component!;
  const update = data.component_update!;
  const page = data.page;

  const compName = component.name || "Unknown Component";
  const newStatus = update.new_status || component.status || "unknown";
  const oldStatus = update.old_status || "unknown";

  return {
    title: `Component Update: ${compName}`,
    description: `**${prettify(oldStatus)}** → **${prettify(newStatus)}**`,
    color: getColor(newStatus),
    fields: [
      {
        name: "Page Status",
        value: page?.status_description || "Unknown",
        inline: false,
      },
    ],
    footer: { text: "Statuspage Component Update" },
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// Discord sender
// ============================================================

async function sendToDiscord(
  webhookUrl: string,
  embed: DiscordEmbed,
): Promise<Response> {
  const payload = {
    username: "Statuspage Monitor",
    embeds: [embed],
  };

  // fetch() is built into Cloudflare Workers, no import needed
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function identifyService(
  pageData: StatuspagePayload,
  db: D1Database,
): Promise<string> {
  const pageID = pageData.page?.id;

  // bail early if there's no page ID in the payload
  if (!pageID) return "";

  // use .bind() instead of string interpolation -- NEVER put variables directly in SQL strings
  const result = await db
    .prepare("SELECT endpointID FROM EndPointsMonitored WHERE atlassianID = ?")
    .bind(pageID) // the ? above gets replaced with pageID safely
    .first(); // we only expect one row back since atlassianID should be unique

  // if no matching row found, return empty string
  if (!result) return "";

  // pull endpointID out of the row and return it as a string
  return String(result.endpointID);
}

async function identifySubscriptions(
  endpointID: string,
  db: D1Database,
): Promise<string[]> {
  // bail early if there's no page ID in the payload
  if (!endpointID) return [];

  // use .bind() instead of string interpolation -- NEVER put variables directly in SQL strings
  const result = await db
    .prepare(
      "SELECT webhookurl FROM DiscordWebUser WHERE ID IN (SELECT discordWebhookUser FROM Subscriptions WHERE monitoredEndpoint = ?)",
    )
    .bind(endpointID) // the ? above gets replaced with pageID safely
    .all(); // we only expect several webhook urls

  // if no matching row found, return empty string
  if (result.results.length === 0) {
    console.log("No Subscriptions found for the following id:", endpointID);
    return [];
  }
  const urls: string[] = result.results.map((row) => String(row.webhookurl));

  // pull endpointID out of the row and return it as a string
  return urls;
}

// ============================================================
// Main handler - this is what Cloudflare calls on every request
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- Health check endpoint ---
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Webhook endpoint ---
    if (
      (url.pathname === "/webhook" || url.pathname === "/") &&
      request.method === "POST"
    ) {
      // Try to parse the incoming JSON body
      let data: StatuspagePayload;
      try {
        data = (await request.json()) as StatuspagePayload;
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      //Figure out what product this is
      const serviceID = await identifyService(data, env.claudestatusdb);

      // Figure out what type of event this is and build the right embed
      let embed: DiscordEmbed;

      if (data.incident) {
        embed = buildIncidentEmbed(data);
      } else if (data.component) {
        embed = buildComponentEmbed(data);
      } else {
        // Unknown payload - dump raw JSON so you can debug it in Discord
        embed = {
          title: "Unknown Statuspage Event",
          description:
            "```json\n" +
            JSON.stringify(data, null, 2).slice(0, 1900) +
            "\n```",
          color: 0x95a5a6,
        };
      }

      //TODO check the database to see who to properly send it to
      const urlsToNotify = await identifySubscriptions(
        serviceID,
        env.claudestatusdb,
      );

      // Forward to Discord
      const discordResponse = await sendToDiscord(
        env.DISCORD_WEBHOOK_URL,
        embed,
      );
      const discordBody = await discordResponse.text();

      // Log it (shows up in `wrangler tail` for debugging)
      console.log(
        `Discord responded: ${discordResponse.status} - ${discordBody}`,
      );

      return new Response(
        JSON.stringify({ discord_status: discordResponse.status }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Anything else gets a 404 ---
    return new Response("Not found", { status: 404 });
  },
};
