# Embed your schedule, agenda, or speaker directory

An embed puts a live Callboard widget on your event's own marketing site, so
visitors can see current programme or speaker information without going to a
Callboard public page. Build and preview the widget in Callboard, then copy its
code or link into the site where it should appear.

## 1. Open the embed builder

Open [Embeds](/admin/embeds). The builder shows a separate card for each widget
and a live preview after you generate its code.

Choose the card that matches what the host page needs:

- **Schedule** shows the published programme grouped by day and start time.
- **Agenda by day** gives each day a heading followed by its times, titles, and
  rooms.
- **Speakers** is a directory of published speakers ordered by surname.
- **Speaker gallery** presents published speakers as photo tiles.

## 2. Set the widget options

Choose a theme and density, and add an accent colour if the widget should match
the host site's branding. For a schedule or agenda, you can also show one track
instead of all tracks.

The preview uses the current choices. Select **Get Code** to generate the output
and check the live preview before copying anything.

## 3. Choose how to publish it

Use an **Iframe** snippet to place the live widget directly inside a page. Paste
the complete snippet into an HTML or embed block in the host site's editor; do
not paste only the URL from its `src` attribute.

Use **Link (HTML)** when the host page should send visitors to the widget rather
than display it inline. The generated markup is a normal link that opens the
widget in a new tab.

For a schedule or agenda, **Calendar feed (iCal)** produces a link to the
event's `.ics` feed. Speaker directory and speaker gallery widgets do not offer
this format because they contain no calendar events.

**JSON** and **XML** are data feeds, not presentation formats: choosing either
one returns the widget's underlying data directly instead of a rendered page,
for a host site that wants to build its own display around Callboard's data
rather than embed Callboard's own markup.

### Custom CSS and hiding fields

A widget can carry its own **Custom CSS**, applied only to that widget. It is
sanitized (`</style` and `<script` are neutralized) and capped at 4,000
characters. You can type and preview it in the builder before saving, but it
only takes effect on the public embed URL once the embed is saved — the
public-facing widget route never reads CSS from its own query string, so
nobody can inject style rules by editing a pasted embed link.

Each widget also offers **Hide fields** checkboxes for its secondary details:
schedule and agenda can hide **Room** and **Track**; speakers and gallery can
hide **Title** and **Company** (a speaker's job title, not the session title).
The item's own identity — a session's title, a speaker's name — can never be
hidden. Hidden fields are omitted from the HTML render and from the JSON/XML
data feeds alike.

## 4. Decide whether to save the embed

A widget copied directly from the builder is live but unsaved. Its URL reads
the theme, track, accent, and density from the query string; Callboard stores no
configuration for it on the server.

To keep a stable configuration, enter a name and select **Save this embed**.
The saved version gets a stable URL ending in `?embed=<id>`, and that URL always
uses the saved settings rather than settings supplied in its query string.

Saving is especially useful when the widget has a track filter or when you want
to manage its availability later. Copy the snippet from the saved embed after
saving, because it contains the stable URL.

## 5. Paste and check the result

Paste the iframe snippet, link, or calendar-feed link into the event's marketing
site. Publish the host page, then check it at desktop and mobile widths. Confirm
that the expected days, sessions, speakers, and track selection appear.

The widget remains live: published programme and speaker changes in Callboard
flow through without replacing the snippet.

## 6. Manage saved embeds

Saved embeds appear below the builder. Select **Disable** to make a saved URL
unavailable without deleting its configuration, or **Enable** to restore it.
Select **Remove** to delete the saved embed outright.

Disabling or removing an embed affects copies of its stable `?embed=<id>` URL
wherever they have been pasted, so check the marketing site before changing an
embed that may still be in use.

## Option reference

| Option | Legal values and availability |
| --- | --- |
| Widget | `schedule`, `agenda`, `speakers` (speaker directory), or `gallery` (speaker gallery) |
| Theme | `light`, `dark`, or `auto`; the default is `auto` |
| Density | `full` or `compact`; the default is `full` |
| Accent colour | Any 3- or 6-digit hex colour, such as `#fff` or `#ffcc00`; any other value is rejected |
| Track filter | Available only for schedule and agenda; speaker directory and gallery are not organized by track |
| Output format | `iframe`, `html` (plain link), `ical` (calendar feed, schedule/agenda only), `json`, or `xml` (JSON/XML are data feeds, not rendered pages) |
| Custom CSS | Up to 4,000 characters, sanitized; previewable live, but only applies on the public embed URL after saving |
| Hide fields | Schedule/agenda: Room, Track. Speakers/gallery: Title, Company. Item identity (session title, speaker name) is never hideable |

## Limitations

- Saved embeds cannot be edited in place; changing settings means saving a new embed and repasting its snippet. See [README: Limitations](../../README.md#limitations).
- A track filter is guaranteed to survive a track rename only when the embed was saved; an unsaved builder snippet refers to the track by name and can become empty after a rename. See [README: Limitations](../../README.md#limitations).
