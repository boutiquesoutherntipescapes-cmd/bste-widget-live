# BSTE Widget Starter (v2)

Your data has been merged from the two CSVs into `config/properties.json`.

## Deploy
1) Create a GitHub repo and upload the contents of this folder.
2) On Vercel: New Project → Import from GitHub → Deploy.
3) Note your deployed URL, e.g. https://YOUR-APP.vercel.app

## Squarespace Embed
- **Header Injection** (once):
  <script defer src="https://YOUR-APP.vercel.app/bste-widget.js"></script>

- **On each property page** (Code Block where you want the widget):
  <div data-bste-widget
       data-property="your-property-slug"
       data-api="https://YOUR-APP.vercel.app"
       data-booking-url="/booking"></div>

Replace `your-property-slug` with one from `config/properties.json`.

