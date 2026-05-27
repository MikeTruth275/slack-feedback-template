// Block Kit UI builders
// These functions return the JSON block structures that Slack renders
// Docs: https://api.slack.com/block-kit

const BUG_REPORT_CHANNEL_ID = process.env.BUG_REPORT_CHANNEL_ID || null;
const JIRA_LABEL_PREFIX = process.env.JIRA_LABEL_PREFIX || "slack-feedback";
const SECRET_PREFIX = process.env.SECRET_PREFIX || "slack-feedback-template/dev/";
const CLOUDWATCH_LOG_GROUP = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? `/aws/lambda/${process.env.AWS_LAMBDA_FUNCTION_NAME}`
  : "/aws/lambda/<your-function-name>";
const APP_DISPLAY_NAME = process.env.SLACK_APP_DISPLAY_NAME || "Product Feedback Bot";

function bugReportHelpText() {
  if (!BUG_REPORT_CHANNEL_ID) return "*Have a bug to report?* Use your normal bug-reporting channel. Do not log bugs via this form.";
  return `*Have a bug to report?*\nLog it in <#${BUG_REPORT_CHANNEL_ID}>. Do not log bugs via this form.`;
}

// ─────────────────────────────────────────────
// FEEDBACK MODAL (what the user sees after /logfeedback)
// ─────────────────────────────────────────────

function buildFeedbackModal(channelName, customFields = []) {
  const blocks = [
    // Customer Name — typeahead search powered by accounts.csv
    {
      type: "input",
      block_id: "customer_block",
      optional: true,
      label: { type: "plain_text", text: "Customer Name" },
      element: {
        type: "external_select",
        action_id: "customer_select",
        placeholder: { type: "plain_text", text: "Start typing to search..." },
        min_query_length: 1,
      },
    },
    // Feedback Title
    {
      type: "input",
      block_id: "title_block",
      label: { type: "plain_text", text: "Feedback Title" },
      element: {
        type: "plain_text_input",
        action_id: "title_input",
        placeholder: { type: "plain_text", text: "Clear, short, and descriptive" },
      },
      hint: { type: "plain_text", text: "A one-liner that captures the core ask." },
    },
    // Description
    {
      type: "input",
      block_id: "description_block",
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "plain_text_input",
        action_id: "description_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "Describe the customer's pain, not the feature.\nWhat workaround are they using today?\nWhat's the impact of solving this?",
        },
      },
    },
    // Loom / Replay link (optional)
    {
      type: "input",
      block_id: "replay_block",
      optional: true,
      label: { type: "plain_text", text: "Link to Loom or Replay" },
      element: {
        type: "plain_text_input",
        action_id: "replay_input",
        placeholder: { type: "plain_text", text: "Paste URL here" },
      },
    },
  ];

  // Inject channel-specific custom fields
  for (const field of customFields) {
    if (field.type === "static_select") {
      blocks.push({
        type: "input",
        block_id: field.blockId,
        optional: field.optional || false,
        label: { type: "plain_text", text: field.label },
        element: {
          type: "static_select",
          action_id: field.actionId,
          placeholder: { type: "plain_text", text: "Select an option" },
          options: field.options.map((opt) => ({
            text: { type: "plain_text", text: opt.text },
            value: opt.value,
          })),
        },
      });
    } else if (field.type === "plain_text_input") {
      blocks.push({
        type: "input",
        block_id: field.blockId,
        optional: field.optional || false,
        label: { type: "plain_text", text: field.label },
        element: {
          type: "plain_text_input",
          action_id: field.actionId,
          multiline: field.multiline || false,
          placeholder: { type: "plain_text", text: field.placeholder || "Write something" },
        },
      });
    }
  }

  // Feedback Type and Urgency always come last
  blocks.push(
    {
      type: "input",
      block_id: "type_block",
      label: { type: "plain_text", text: "Feedback Type" },
      element: {
        type: "static_select",
        action_id: "type_select",
        placeholder: { type: "plain_text", text: "Select type" },
        options: [
          { text: { type: "plain_text", text: "New Capability — Something that doesn't exist today" }, value: "new_capability" },
          { text: { type: "plain_text", text: "Enhancement — Something that exists but needs to be better" }, value: "enhancement" },
          { text: { type: "plain_text", text: "General Question — Doesn't fit the categories above" }, value: "general_question" },
        ],
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: bugReportHelpText(),
        },
      ],
    },
    {
      type: "input",
      block_id: "urgency_block",
      label: { type: "plain_text", text: "Urgency" },
      element: {
        type: "static_select",
        action_id: "urgency_select",
        placeholder: { type: "plain_text", text: "Select urgency" },
        options: [
          { text: { type: "plain_text", text: "Blocking" }, value: "blocking" },
          { text: { type: "plain_text", text: "High" }, value: "high" },
          { text: { type: "plain_text", text: "Medium" }, value: "medium" },
          { text: { type: "plain_text", text: "Low" }, value: "low" },
        ],
      },
    },
    // Context footer
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Submitting to *#${channelName}*`,
        },
      ],
    }
  );

  return {
    type: "modal",
    callback_id: "feedback_modal_submit",
    title: { type: "plain_text", text: "Log Feedback" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// ─────────────────────────────────────────────
// CHANNEL POST (what gets posted after modal submit)
// ─────────────────────────────────────────────

const URGENCY_EMOJI = {
  blocking: ":red_circle:",
  high: ":large_orange_circle:",
  medium: ":large_yellow_circle:",
  low: ":white_circle:",
};

const TYPE_LABEL = {
  bug: "Bug",
  new_capability: "New Capability",
  enhancement: "Enhancement",
  general_question: "General Question",

};

// Stable block_id for the "Possible duplicate" context line so we can locate
// and remove it on dismiss without scanning text.
const DUPLICATE_HINT_BLOCK_ID = "duplicate_hint";

function buildFeedbackPost({ feedbackId, customer, title, type, urgency, description, replay, customFields, customFieldDefs, reporterUserId, pmUserId, productArea, jiraTicket = null, duplicateHint = null }) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `:clipboard: ${title}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Customer:*\n${customer}` },
        { type: "mrkdwn", text: `*Type:*\n${TYPE_LABEL[type] || type}` },
        { type: "mrkdwn", text: `*Urgency:*\n${URGENCY_EMOJI[urgency] || ""} ${urgency.charAt(0).toUpperCase() + urgency.slice(1)}` },
        { type: "mrkdwn", text: `*Product Area:*\n${productArea}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Description:*\n${description}` },
    },
  ];

  // Add replay link if provided
  if (replay) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Replay:* <${replay}|View recording>` },
    });
  }

  // Add custom field values if any
  if (customFields && customFieldDefs && customFieldDefs.length > 0) {
    for (const fieldDef of customFieldDefs) {
      const value = customFields[fieldDef.blockId];
      if (value) {
        // For select fields, find the display text from the options
        let displayValue = value;
        if (fieldDef.type === "static_select" && fieldDef.options) {
          const match = fieldDef.options.find((opt) => opt.value === value);
          if (match) displayValue = match.text;
        }
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*${fieldDef.label}:*\n${displayValue}` },
        });
      }
    }
  }

  // Divider, context, and actions
  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Submitted by <@${reporterUserId}>${pmUserId ? ` · Routed to <@${pmUserId}>` : ""} · ID: \`${feedbackId}\``,
        },
      ],
    }
  );

  blocks.push(buildFeedbackActionsBlock(feedbackId, jiraTicket));

  if (jiraTicket) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:ticket: *Jira:* <${jiraTicket.url}|${jiraTicket.key}>`,
        },
      ],
    });
  }

  if (duplicateHint && !jiraTicket) {
    blocks.push(buildDuplicateHintContextBlock(duplicateHint));
  }

  return blocks;
}

// Subtle one-line "Possible duplicate" context block that lives on the
// channel post itself. Kept tiny on purpose -- the full ranked list with
// resolve buttons is posted as a thread reply.
function buildDuplicateHintContextBlock({ key, url }) {
  return {
    type: "context",
    block_id: DUPLICATE_HINT_BLOCK_ID,
    elements: [
      {
        type: "mrkdwn",
        text: `:link: Possible duplicate of <${url}|${key}> \u2014 PM review`,
      },
    ],
  };
}

// Add or replace the duplicate hint on an existing channel post. Idempotent.
function applyDuplicateHintToBlocks(blocks, hint) {
  const next = blocks.filter(
    (b) => !(b.type === "context" && b.block_id === DUPLICATE_HINT_BLOCK_ID)
  );
  if (hint) {
    next.push(buildDuplicateHintContextBlock(hint));
  }
  return next;
}

function removeDuplicateHintFromBlocks(blocks) {
  return blocks.filter(
    (b) => !(b.type === "context" && b.block_id === DUPLICATE_HINT_BLOCK_ID)
  );
}

// Standalone so we can rebuild this block when a Jira ticket is later added.
function buildFeedbackActionsBlock(feedbackId, jiraTicket) {
  const elements = [
    {
      type: "button",
      text: { type: "plain_text", text: "Respond", emoji: true },
      action_id: "feedback_respond",
      style: "primary",
      value: feedbackId,
    },
  ];

  if (!jiraTicket) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Create Jira Ticket", emoji: true },
      action_id: "channel_create_jira_ticket",
      value: feedbackId,
    });
  }

  elements.push({
    type: "button",
    text: { type: "plain_text", text: "Reroute", emoji: true },
    action_id: "feedback_reroute",
    value: feedbackId,
  });

  return {
    type: "actions",
    block_id: `feedback_actions_${feedbackId}`,
    elements,
  };
}

// Apply a newly-created Jira ticket to an existing channel post: swap the
// actions block (drops "Create Jira Ticket") and append a Jira link context.
function applyJiraTicketToFeedbackBlocks(blocks, feedbackId, jiraTicket) {
  const next = blocks.filter((b) => {
    // Drop any prior Jira link context block (string match) and any prior
    // "Possible duplicate" hint -- the real link supersedes the hint.
    if (b.type !== "context") return true;
    if (b.block_id === DUPLICATE_HINT_BLOCK_ID) return false;
    const text = b.elements?.[0]?.text || "";
    return !text.startsWith(":ticket: *Jira:*");
  });

  const idx = next.findIndex(
    (b) => b.type === "actions" && b.block_id === `feedback_actions_${feedbackId}`
  );
  if (idx >= 0) {
    next[idx] = buildFeedbackActionsBlock(feedbackId, jiraTicket);
  }

  next.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:ticket: *Jira:* <${jiraTicket.url}|${jiraTicket.key}>`,
      },
    ],
  });

  return next;
}

// ─────────────────────────────────────────────
// RESPONSE MODAL (when PM clicks "Respond" button)
// ─────────────────────────────────────────────

function buildResponseModal(feedbackId, feedbackSummary) {
  return {
    type: "modal",
    callback_id: "feedback_response_submit",
    private_metadata: feedbackId,
    title: { type: "plain_text", text: "Respond to Feedback" },
    submit: { type: "plain_text", text: "Post Response" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Original feedback:*\n>${feedbackSummary}` },
      },
      { type: "divider" },
      {
        type: "input",
        block_id: "response_block",
        label: { type: "plain_text", text: "Your Response" },
        element: {
          type: "plain_text_input",
          action_id: "response_input",
          multiline: true,
          placeholder: { type: "plain_text", text: "Type your response to the reporter..." },
        },
      },
      {
        type: "input",
        block_id: "status_block",
        label: { type: "plain_text", text: "Update Status" },
        element: {
          type: "static_select",
          action_id: "status_select",
          options: [
            { text: { type: "plain_text", text: "Acknowledged - Will Follow Up" }, value: "acknowledged" },
            { text: { type: "plain_text", text: "Needs More Info" }, value: "needs_more_info" },
            { text: { type: "plain_text", text: "In Progress" }, value: "in_progress" },
            { text: { type: "plain_text", text: "Planned" }, value: "planned" },
            { text: { type: "plain_text", text: "Already Available" }, value: "already_available" },
            { text: { type: "plain_text", text: "Not Planned" }, value: "not_planned" },
            { text: { type: "plain_text", text: "Resolved" }, value: "resolved" },
          ],
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────
// HOME TAB (PM triage dashboard)
// ─────────────────────────────────────────────

function buildHomeTab({ userName, userId, pendingItems, respondedItems, isAdmin }) {
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `:house: ${APP_DISPLAY_NAME}`, emoji: true },
  });

  const urgentCount = pendingItems.filter(
    (i) => i.submission.urgency === "blocking" || i.submission.urgency === "high"
  ).length;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `Hey ${userName}. You have *${pendingItems.length} pending* feedback items${urgentCount > 0 ? ` (${urgentCount} urgent)` : ""} and *${respondedItems.length} responded* this week.`,
    },
  });

  blocks.push({ type: "divider" });

  if (pendingItems.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":white_check_mark: All caught up. No pending feedback." },
    });
    if (userId && respondedItems.length === 0) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Home only lists feedback assigned to your Slack member ID._ \`${userId}\` _— if channel posts exist but this stays empty, check_ \`channel-config.js\` _\`pmUserId\` for that channel matches this ID._`,
          },
        ],
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Pending Feedback*" },
    });

    for (const item of pendingItems.slice(0, 15)) {
      const urgEmoji = URGENCY_EMOJI[item.submission.urgency] || "";
      const age = getAge(item.createdAt);
      const titleLine = item.submission.title
        ? `*${item.submission.customer}* — ${item.submission.title}`
        : `*${item.submission.customer}*`;
      const preview = item.submission.description.length > 100
        ? item.submission.description.slice(0, 100) + "..."
        : item.submission.description;

      const jiraTag = item.jiraTicket
        ? ` · <${item.jiraTicket.url}|${item.jiraTicket.key}>`
        : "";

      const threadTag = item.slackPermalink
        ? ` · <${item.slackPermalink}|View thread>`
        : "";

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${urgEmoji} ${titleLine} · ${TYPE_LABEL[item.submission.type] || item.submission.type} · _${age}_${jiraTag}${threadTag}\n${preview}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Respond" },
          action_id: "home_respond",
          value: item.id,
        },
      });

      const actionElements = [];
      if (!item.jiraTicket) {
        actionElements.push({
          type: "button",
          text: { type: "plain_text", text: "Create Jira Ticket", emoji: true },
          action_id: "home_create_jira_ticket",
          value: item.id,
        });
      }
      actionElements.push({
        type: "button",
        text: { type: "plain_text", text: "Reroute", emoji: true },
        action_id: "home_reroute",
        value: item.id,
      });
      blocks.push({
        type: "actions",
        elements: actionElements,
      });
    }

    if (pendingItems.length > 15) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_+ ${pendingItems.length - 15} more items. Respond to these first._` }],
      });
    }
  }

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Recently Responded* (${respondedItems.length})`,
    },
  });

  if (respondedItems.length > 0) {
    const respondedSummary = respondedItems
      .slice(0, 5)
      .map((i) => {
        const label = i.submission.title || i.submission.customer;
        return `  :white_check_mark: ${label} · ${TYPE_LABEL[i.submission.type]} · _${i.status.replace("_", " ")}_`;
      })
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: respondedSummary },
    });
  }

  return { type: "home", blocks };
}

function getAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─────────────────────────────────────────────
// JIRA TICKET MODAL (when PM clicks "Create Jira Ticket")
// ─────────────────────────────────────────────

const URGENCY_TO_JIRA_PRIORITY = {
  blocking: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const COMMON_ISSUE_TYPES = [
  { text: "Story", value: "Story" },
  { text: "Bug", value: "Bug" },
  { text: "Task", value: "Task" },
  { text: "Epic", value: "Epic" },
  { text: "Spike", value: "Spike" },
];

const JIRA_PRIORITIES = [
  { text: "Highest", value: "Highest" },
  { text: "High", value: "High" },
  { text: "Medium", value: "Medium" },
  { text: "Low", value: "Low" },
  { text: "Lowest", value: "Lowest" },
];

// Issue types that support attaching to an Epic parent. Epic itself, Sub-task,
// and Initiative are intentionally excluded (different parent semantics).
const PARENT_ELIGIBLE_ISSUE_TYPES = new Set(["Story", "Task", "Bug", "Spike"]);

function isParentEligible(issueTypeName) {
  if (!issueTypeName) return false;
  return PARENT_ELIGIBLE_ISSUE_TYPES.has(issueTypeName);
}

function buildJiraTicketModal(
  feedbackId,
  record,
  {
    slackPermalink = null,
    projectKey = null,
    selectedIssueType = null,
    parentKey = null,
    teamId = null,
    // Project config for the currently selected project: null when no project
    // chosen yet or when the project doesn't require Team. Shape:
    //   { requiresTeam, teamFieldId, teams: [{ name, id }, ...] }
    projectConfig = null,
    initialValues = {},
  } = {}
) {
  const sub = record.submission;
  const defaultPriority = URGENCY_TO_JIRA_PRIORITY[sub.urgency] || "Medium";

  const descriptionParts = [
    `*Customer:* ${sub.customer}`,
    `*Type:* ${TYPE_LABEL[sub.type] || sub.type}`,
    `*Urgency:* ${sub.urgency}`,
    `*Reporter:* ${record.reporter.name}`,
    `*Product Area:* ${record.productArea}`,
    "",
    sub.description,
  ];
  if (sub.replay) descriptionParts.push("", `Replay: ${sub.replay}`);
  if (slackPermalink) descriptionParts.push("", `Slack thread: ${slackPermalink}`);
  descriptionParts.push("", `Feedback ID: ${feedbackId}`);

  // initialValues lets re-renders (project change, issue type change) preserve
  // anything the PM has already typed. Without this, every views.update would
  // clobber the description back to the auto-generated version.
  const summaryValue =
    initialValues.summary != null
      ? initialValues.summary
      : sub.title || `${sub.customer}: ${sub.description.slice(0, 80)}`;
  const descriptionValue =
    initialValues.description != null ? initialValues.description : descriptionParts.join("\n");
  const priorityValue = initialValues.priority || defaultPriority;
  const labelsValue = initialValues.labels != null ? initialValues.labels : "";
  const contextValue = initialValues.context != null ? initialValues.context : "";

  // private_metadata is a JSON blob so we can carry selected state across
  // modal re-renders and the final submit. teamFieldId is also stashed here
  // so the submit handler knows which custom field to set without having to
  // re-resolve the project config.
  const privateMetadata = JSON.stringify({
    feedbackId,
    projectKey,
    selectedIssueType,
    parentKey,
    teamId,
    teamFieldId: projectConfig?.requiresTeam ? projectConfig.teamFieldId : null,
    slackPermalink,
  });

  // Issue Type element: until a project is picked, fall back to a static list
  // (so the field is selectable). Once we know the project, swap in an
  // external_select that loads project-specific issue types from Jira.
  const issueTypeElement = projectKey
    ? {
        type: "external_select",
        action_id: "jira_issue_type_select",
        placeholder: { type: "plain_text", text: "Select issue type" },
        min_query_length: 0,
      }
    : {
        type: "static_select",
        action_id: "jira_issue_type_select",
        placeholder: { type: "plain_text", text: "Pick a project first" },
        options: COMMON_ISSUE_TYPES.map((t) => ({
          text: { type: "plain_text", text: t.text },
          value: t.value,
        })),
      };
  // Re-seed the currently selected option so the user sees their pick after
  // a re-render. Both static_select and external_select use initial_option.
  if (selectedIssueType) {
    issueTypeElement.initial_option = {
      text: { type: "plain_text", text: selectedIssueType },
      value: selectedIssueType,
    };
  }

  const blocks = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Creating ticket from feedback: *${sub.customer}* — ${sub.title || "No title"}`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "input",
      block_id: "jira_project_block",
      label: { type: "plain_text", text: "Jira Project" },
      dispatch_action: true,
      element: {
        type: "external_select",
        action_id: "jira_project_select",
        placeholder: { type: "plain_text", text: "Search for a project..." },
        min_query_length: 0,
        // When projectKey is pre-seeded (channel-level default or a prior
        // pick that survived a re-render), we want the dropdown to show
        // the same `KEY — Name` formatting the options handler uses, so
        // it doesn't read as a bare opaque key like "WE". projectConfig
        // carries .name for projects we know about; for projects without
        // a config entry we fall back to just the key.
        ...(projectKey
          ? {
              initial_option: {
                text: {
                  type: "plain_text",
                  text: projectConfig?.name
                    ? `${projectKey} — ${projectConfig.name}`
                    : projectKey,
                },
                value: projectKey,
              },
            }
          : {}),
      },
    },
    {
      type: "input",
      block_id: "jira_issue_type_block",
      label: { type: "plain_text", text: "Issue Type" },
      // dispatch_action lets us re-render to show/hide the parent picker.
      dispatch_action: true,
      element: issueTypeElement,
    },
  ];

  // Required Team picker -- only shown when the chosen project requires it.
  // This is the workaround for projects whose workflow validators mandate
  // the Atlassian Teams field (which /createmeta does not surface).
  if (projectConfig?.requiresTeam && Array.isArray(projectConfig.teams) && projectConfig.teams.length > 0) {
    const teamElement = {
      type: "static_select",
      action_id: "jira_team_select",
      placeholder: { type: "plain_text", text: "Select a team" },
      options: projectConfig.teams.map((t) => ({
        text: { type: "plain_text", text: t.name },
        value: t.id,
      })),
    };
    if (teamId) {
      const match = projectConfig.teams.find((t) => t.id === teamId);
      if (match) {
        teamElement.initial_option = {
          text: { type: "plain_text", text: match.name },
          value: match.id,
        };
      }
    }
    blocks.push({
      type: "input",
      block_id: "jira_team_block",
      label: { type: "plain_text", text: "Team" },
      element: teamElement,
      hint: {
        type: "plain_text",
        text: "Required for this project. Sets Jira's Team field on the new issue.",
      },
    });
  }

  // Optional Parent Epic picker -- only shown when a project is chosen AND
  // the selected issue type is one that supports an Epic parent.
  if (projectKey && isParentEligible(selectedIssueType)) {
    const parentElement = {
      type: "external_select",
      action_id: "jira_parent_select",
      placeholder: { type: "plain_text", text: "Search Epics by key or summary" },
      min_query_length: 2,
    };
    if (parentKey) {
      parentElement.initial_option = {
        text: { type: "plain_text", text: parentKey },
        value: parentKey,
      };
    }
    blocks.push({
      type: "input",
      block_id: "jira_parent_block",
      optional: true,
      label: { type: "plain_text", text: "Parent Epic" },
      element: parentElement,
      hint: {
        type: "plain_text",
        text: "Optional. Type at least 2 characters to search open Epics in this project.",
      },
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "jira_summary_block",
      label: { type: "plain_text", text: "Summary" },
      element: {
        type: "plain_text_input",
        action_id: "jira_summary_input",
        initial_value: summaryValue,
        placeholder: { type: "plain_text", text: "Ticket summary" },
      },
    },
    {
      type: "input",
      block_id: "jira_description_block",
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "plain_text_input",
        action_id: "jira_description_input",
        multiline: true,
        initial_value: descriptionValue,
      },
    },
    {
      type: "input",
      block_id: "jira_priority_block",
      label: { type: "plain_text", text: "Priority" },
      element: {
        type: "static_select",
        action_id: "jira_priority_select",
        initial_option: {
          text: { type: "plain_text", text: priorityValue },
          value: priorityValue,
        },
        options: JIRA_PRIORITIES.map((p) => ({
          text: { type: "plain_text", text: p.text },
          value: p.value,
        })),
      },
    },
    {
      type: "input",
      block_id: "jira_labels_block",
      optional: true,
      label: { type: "plain_text", text: "Labels" },
      element: {
        type: "plain_text_input",
        action_id: "jira_labels_input",
        ...(labelsValue ? { initial_value: labelsValue } : {}),
        placeholder: { type: "plain_text", text: "Comma-separated labels (e.g. customer-feedback, connectors)" },
      },
      hint: { type: "plain_text", text: `Optional. Separate multiple labels with commas. ${JIRA_LABEL_PREFIX} (and ${JIRA_LABEL_PREFIX}-<area>) are added automatically.` },
    },
    {
      type: "input",
      block_id: "jira_context_block",
      optional: true,
      label: { type: "plain_text", text: "Additional Context" },
      element: {
        type: "plain_text_input",
        action_id: "jira_context_input",
        multiline: true,
        ...(contextValue ? { initial_value: contextValue } : {}),
        placeholder: { type: "plain_text", text: "Any extra context for the engineering team..." },
      },
    }
  );

  return {
    type: "modal",
    callback_id: "jira_ticket_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Create Jira Ticket" },
    submit: { type: "plain_text", text: "Create Ticket" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function buildJiraNotConfiguredModal() {
  return {
    type: "modal",
    callback_id: "jira_not_configured",
    title: { type: "plain_text", text: "Jira Not Configured" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *Jira ticket creation is unavailable.*\n\n${APP_DISPLAY_NAME} is not connected to Jira. The three secrets the Lambda expects in AWS Secrets Manager under the \`${SECRET_PREFIX}\` prefix are:\n\n• \`JIRA_BASE_URL\` (e.g. \`https://your-org.atlassian.net\`)\n• \`JIRA_USER_EMAIL\` (service account email)\n• \`JIRA_API_TOKEN\` (token from id.atlassian.com/manage-profile/security/api-tokens)\n\nOne or more is missing, the API token is invalid, or the account doesn't have *Browse Projects* permission. Check CloudWatch logs for \`${CLOUDWATCH_LOG_GROUP}\` for the exact Jira API error.`,
        },
      },
    ],
  };
}

function buildJiraAlreadyLinkedModal(jiraTicket) {
  return {
    type: "modal",
    callback_id: "jira_already_linked",
    title: { type: "plain_text", text: "Already Linked" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:link: This feedback is already linked to Jira ticket <${jiraTicket.url}|${jiraTicket.key}>.\n\nIf you need a second ticket, create it directly in Jira and link it manually.`,
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────
// DUPLICATE SUGGESTION THREAD MESSAGE
// ─────────────────────────────────────────────

// Block Kit body for the threaded "Possible duplicates" reply.
// `matches` is the merged list -- each item has Jira metadata (key, url,
// summary, status) plus the LLM rerank result (score, reason).
function buildDuplicateSuggestionsBlocks({ feedbackId, matches }) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          ":mag: *Possible duplicates in Jira*\n" +
          "_Top matches from existing feedback tickets, ranked by Claude (Bedrock). Use Resolve if one of these already covers the request._",
      },
    },
    { type: "divider" },
  ];

  for (const m of matches) {
    const scorePct = Math.round((m.score || 0) * 100);
    const status = m.status ? ` · _${m.status}_` : "";
    const summary = m.summary && m.summary.length > 180
      ? m.summary.slice(0, 177) + "..."
      : (m.summary || "(no summary)");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${m.url}|*${m.key}*> — ${escapeMrkdwn(summary)}${status}\n_Confidence: ${scorePct}% — ${escapeMrkdwn(m.reason || "")}_`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Resolve as duplicate" },
        style: "primary",
        action_id: "resolve_as_duplicate",
        // Pack feedbackId + jiraKey into the value -- single-button payload
        // limit is plenty for this and avoids needing private_metadata.
        value: `${feedbackId}::${m.key}`,
        confirm: {
          title: { type: "plain_text", text: "Mark as duplicate?" },
          text: {
            type: "mrkdwn",
            text: `This will link this feedback to *${m.key}*, set its status to *resolved*, and remove the Create Jira Ticket button.`,
          },
          confirm: { type: "plain_text", text: "Resolve" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      },
    });
  }

  blocks.push({
    type: "actions",
    block_id: `duplicate_suggestions_actions_${feedbackId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Not a duplicate" },
        action_id: "dismiss_duplicate_suggestions",
        value: feedbackId,
      },
    ],
  });

  return blocks;
}

// ─────────────────────────────────────────────
// ROUTING NUDGE (thread reply when classifier disagrees with channel)
// ─────────────────────────────────────────────

// Thread-reply blocks shown under the feedback when the classifier thinks it
// likely belongs to a different product area. Includes a Reroute button that
// pre-selects the suggested target channel and a Dismiss button that removes
// the reply.
function buildRoutingNudgeBlocks({ feedbackId, suggestion, currentConfig, currentChannelId, currentChannelName, targetConfig, targetChannelId, targetChannelName }) {
  const confidencePct = Math.round((suggestion.confidence || 0) * 100);
  const reasonLine = suggestion.reason
    ? `\n_${escapeMrkdwn(suggestion.reason)}_`
    : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:thinking_face: This looks like it might be *${targetConfig.name}* feedback (${confidencePct}% confidence).\n` +
          `Currently assigned to <@${currentConfig.pmUserId}> in <#${currentChannelId}|${currentChannelName}>. ` +
          `Suggested: <@${targetConfig.pmUserId}> in <#${targetChannelId}|${targetChannelName}>.` +
          reasonLine,
      },
    },
    {
      type: "actions",
      block_id: `routing_nudge_actions_${feedbackId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Reroute to ${targetConfig.name}`, emoji: true },
          action_id: "routing_nudge_reroute",
          style: "primary",
          value: `${feedbackId}::${targetChannelId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss", emoji: true },
          action_id: "routing_nudge_dismiss",
          value: feedbackId,
        },
      ],
    },
  ];
}

// ─────────────────────────────────────────────
// REROUTE MODAL
// ─────────────────────────────────────────────

// Modal lets a PM move a feedback item to a different configured channel.
// channelConfig is the full config map; currentChannelId is excluded from the
// options. suggestedChannelId, if provided (from the classifier nudge), is
// pre-selected.
function buildRerouteModal({ feedbackId, currentChannelId, currentConfig, channelConfig, suggestedChannelId = null }) {
  const options = Object.entries(channelConfig)
    .filter(([id]) => id !== currentChannelId)
    .map(([id, cfg]) => ({
      text: {
        type: "plain_text",
        text: `${cfg.name}${cfg.pmName ? ` \u2014 ${cfg.pmName}` : ""}`,
      },
      value: id,
    }));

  const initialOption =
    suggestedChannelId && channelConfig[suggestedChannelId]
      ? options.find((o) => o.value === suggestedChannelId) || null
      : null;

  const currentLabel = currentConfig
    ? `${currentConfig.name}${currentConfig.pmName ? ` \u2014 ${currentConfig.pmName}` : ""}`
    : "(unknown)";

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Currently routed to:* ${escapeMrkdwn(currentLabel)}\n\nPick a different product area to move this feedback. The original channel post will be marked as moved, a fresh post will be created in the target channel, and the assigned PM will update.`,
      },
    },
    {
      type: "input",
      block_id: "reroute_target_block",
      label: { type: "plain_text", text: "Reroute to" },
      element: {
        type: "static_select",
        action_id: "reroute_target_select",
        placeholder: { type: "plain_text", text: "Pick a product area" },
        options,
        ...(initialOption ? { initial_option: initialOption } : {}),
      },
    },
    {
      type: "input",
      block_id: "reroute_reason_block",
      optional: true,
      label: { type: "plain_text", text: "Reason (optional)" },
      element: {
        type: "plain_text_input",
        action_id: "reroute_reason_input",
        multiline: false,
        max_length: 240,
        placeholder: { type: "plain_text", text: "e.g. Actually about Platform, not Core Product" },
      },
    },
  ];

  return {
    type: "modal",
    callback_id: "feedback_reroute_submit",
    private_metadata: JSON.stringify({ feedbackId, fromChannelId: currentChannelId }),
    title: { type: "plain_text", text: "Reroute Feedback" },
    submit: { type: "plain_text", text: "Reroute" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// Banner prepended to the *original* post after a reroute so nobody actions it.
function buildMovedBanner({ toChannelId, toChannelName, newPermalink }) {
  const link = newPermalink
    ? `<${newPermalink}|new thread>`
    : `<#${toChannelId}|${toChannelName}>`;
  return {
    type: "context",
    block_id: "reroute_moved_banner",
    elements: [
      {
        type: "mrkdwn",
        text: `:inbox_tray: *Moved to* <#${toChannelId}|${toChannelName}> \u2014 see ${link}. This copy is no longer actionable.`,
      },
    ],
  };
}

// Banner prepended to the *new* post after a reroute so the audit trail is clear.
function buildReroutedFromBanner({ fromChannelId, fromChannelName, oldPermalink, actingUserId, reason }) {
  const link = oldPermalink
    ? `<${oldPermalink}|original thread>`
    : `<#${fromChannelId}|${fromChannelName}>`;
  const reasonLine = reason ? `\n_Reason: ${escapeMrkdwn(reason)}_` : "";
  return {
    type: "context",
    block_id: "reroute_from_banner",
    elements: [
      {
        type: "mrkdwn",
        text:
          `:arrows_counterclockwise: *Rerouted from* <#${fromChannelId}|${fromChannelName}> by <@${actingUserId}>. ${link}.` +
          reasonLine,
      },
    ],
  };
}

// Strips action buttons from a feedback post and prepends a "moved to" banner
// so the original remains visible but no longer actionable.
function applyMovedBannerAndStripActions(blocks, feedbackId, movedBanner) {
  const filtered = blocks.filter(
    (b) => !(b.type === "actions" && b.block_id === `feedback_actions_${feedbackId}`)
  );
  return [movedBanner, ...filtered];
}

// Slack mrkdwn escaping for the few characters that can derail rendering when
// they appear inside generated text (Jira summaries can contain anything).
function escapeMrkdwn(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  buildFeedbackModal,
  buildFeedbackPost,
  buildFeedbackActionsBlock,
  applyJiraTicketToFeedbackBlocks,
  applyDuplicateHintToBlocks,
  removeDuplicateHintFromBlocks,
  buildDuplicateSuggestionsBlocks,
  buildResponseModal,
  buildHomeTab,
  buildRoutingNudgeBlocks,
  buildRerouteModal,
  buildMovedBanner,
  buildReroutedFromBanner,
  applyMovedBannerAndStripActions,
  buildJiraTicketModal,
  buildJiraAlreadyLinkedModal,
  buildJiraNotConfiguredModal,
};