Logos for the apps Crewtavo connects to, shown on the Apps page to identify each integration. They
are trademarks of their owners. crewtavo.svg is Crewtavo's own mark (public/crewtavo-mark.svg, in its
light-background colors), for the apps built into Crewtavo, such as Crewtavo - Team Chat. Stripe, Google Calendar, Twilio, Claude and ChatGPT (OpenAI) come
from svgl.app; QuickBooks and Zoho are Simple Icons (CC0) in each brand's color. sveltia.svg is
Sveltia CMS's logo from sveltiacms.app (images/logo/sveltia-logo.svg); it's already a rounded app
icon, so AppIcon.tsx shows it edge to edge. outlook.svg is a
simplified mark in Outlook's colors drawn for Crewtavo. Apple Calendar and "Other calendars" have no
file: AppIcon.tsx draws today's date and a calendar glyph instead. google-business.svg is a
simplified storefront in Google's colors drawn for Crewtavo, for the Google Business Profile app.
meta.svg is a speech bubble and a camera in Facebook's blue and Instagram's gradient, drawn for
Crewtavo, for the Facebook & Instagram app (not Meta's own logo).

fal.svg is fal.ai's mark from @lobehub/icons-static-svg 1.95.1 (MIT), in fal's red, for the fal.ai app
(Find paving).

abc-supply.svg is ABC Supply's logo as its own website shows it (abcsupply.com, wp-content/uploads/
2026/03/ABC-US-Exteriors-Logo.svg, downloaded 2026-10-22), in ABC's red and blue, for the ABC Supply
app (material prices). It's a wordmark, so AppIcon.tsx gives it more width.

Settings → AI assistants shows each connected assistant's logo (assistantConnections.ts): claude.svg
for Claude and Claude Code, chatgpt.svg for ChatGPT, and codex.svg for Codex, OpenAI's Codex mark
from svgl.app (MIT) in the blue-violet gradient of Codex's app icon (from @lobehub/icons 1.95.1).

Settings → Email shows the mail providers' logos the same way (EmailSettings.tsx), reusing zoho.svg
for Zoho Mail and outlook.svg for Microsoft 365 / Outlook:

- gmail.svg: Gmail's M, from svgl.app (MIT).
- google.svg: Google's G, for Google Workspace, from svgl.app (MIT): its flat four-color G as
  published in the svgl-react 1.1.4 package (svgl.app has since moved to Google's 2025 gradient G).
- yahoo.svg: Yahoo's Y!, Simple Icons 9.20.0 (CC0), in Yahoo purple.
- icloud.svg: iCloud's cloud, Simple Icons 16.35.0 (CC0), in iCloud blue.
- resend.svg: Resend's R, Simple Icons 16.35.0 (CC0), in black.

"Another email provider" has no file: it keeps the mail icon.
