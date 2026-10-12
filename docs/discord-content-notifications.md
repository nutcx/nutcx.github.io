# Discord content announcements

The existing Pages workflow announces new or updated **installable replacement routes**
after the website successfully deploys. No Android app or Admin update is required.

Keep `DISCORD_WEBHOOK_URL` in this repository's **Actions secrets**. Do not put it in
Pages files, app configuration, source control, screenshots, or workflow artifacts.
Only the configuration check and sending step receive the webhook URL; the history lookup uses the built-in
GitHub token with Actions read permission.

## What members see

- One `@everyone` at the start of the publication's first message. Additional messages
  in a large update do not ping users again. Other role/user mentions are disabled.
- Each changed replacement appears once, grouped with its changed originals. Named or
  image-specific effect variants remain distinct.
- Comparison images show the original on the left and the replacement on the right,
  with names below. Multiple originals use comparison rows in the same attachment;
  at most eight are pictured, with a note for further originals.
- Changed-original links open their precise website replacement route. Missing images
  say “Preview unavailable”; they are not guessed. Archived routes with no usable
  archive are not announced.

Discord can still suppress push notifications according to channel permissions and
each member's notification preferences. The sender checks whether Discord parsed the
everyone mention, but cannot prove that every member received a push alert.

## When messages are sent

The notifier reads the **locally verified signed delivery**, not an unsigned database.
It confirms that the live website serves this deployment's exact manifest before
announcing it. Archive changes are detected even when item IDs remain unchanged.
Reordering, timestamps, removed routes, client policy/config-only changes and ordinary
website rebuilds do not generate content announcements.

The **first enabled run is silent**: it saves the current catalog as its baseline so
existing content is not advertised as thousands of new updates. Subsequent runs compare
with the last durable announcement state, rather than the previous Git commit.

`discord-state-*` Actions artifacts retain only a notification snapshot (including
archive hashes, not archive URLs), status and confirmed message IDs. No signing key,
webhook URL, raw database JSON, or comparison image is included in these records.
Nothing is added to the signed `public/content` delivery tree.

History artifacts expire after 90 days. Scheduled successful runs refresh the baseline;
if all records expire or are deleted, the next run seeds silently again. That avoids
reposting the whole catalog but does not reconstruct missed announcements.

## Interrupted sends

A pending intent is uploaded **before any webhook request**. Confirmed message IDs are
saved after each successful response. If a send times out, a run is canceled, or result
storage fails, the next run stops for review instead of automatically repeating a
possibly delivered announcement. This is conservative duplicate protection, not a
claim that Discord provides exactly-once delivery.

Between confirmed message batches, the sender respects Discord's remaining-request
and reset-after headers. An exhausted bucket pauses the next request; an unusually
long or invalid reset window stops for review rather than replaying a POST.

1. Check the Discord channel and the latest `discord-state-*` artifact. Confirm which
   messages arrived; their IDs, when known, are in `receipts`.
2. To treat that interrupted publication as handled **without reposting it**, run
   **Deploy to GitHub Pages** manually on `main` and choose
   `discord_recovery: skip-interrupted`. Any unsent messages from that publication will
   be skipped. Newer catalog changes are still compared against its candidate snapshot.
3. Do not delete pending history to force a retry unless you have checked for duplicates.
   There is deliberately no blind automatic POST retry.

Notification failure does not undo or block the already-successful website deployment.
The `notify-discord` job remains visible in Actions for inspection.

## Local verification

Run `pnpm test:discord` for semantic diffs, limits, image composition/downloading,
durable state planning, mention policy, multipart sending and interrupted-send behavior.
Run `pnpm test` for the full website suite. Tests use synthetic local images and injected
HTTP responses; they never use the production webhook or send live Discord messages.

Official references: [Discord webhooks](https://docs.discord.com/developers/resources/webhook),
[allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object),
and [GitHub Actions artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
