<h1 align="center">UTRehome</h1>
<h3 align="center">Replace YouTube's Home with Subscriptions</h3>

<p align="center">Replaces YouTube's home feed with your subscriptions. Toggle between Subscriptions and Recommended at any time.</p>

## About

This extension replaces YouTube's algorithmically-curated home feed with your actual subscription content, rendered directly on the home page. No redirects — it fetches your subscriptions via YouTube's InnerTube API and displays them in a native-looking grid.

Toggle between **Subscriptions** and **Recommended** views using the chip-style tabs at the top of the home page.

### Features

- Subscription feed rendered on the home page (no redirect)
- Toggle between Subscriptions and Recommended views
- Infinite scroll support
- Dark/light theme support via YouTube's CSS variables
- View preference persistence
- SPA navigation aware

## Install

Load as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked) or as a temporary add-on in Firefox (`about:debugging`).

## Credits

Originally forked from [YTMySubs v1.1.1](https://github.com/SeinopSys/YTMySubs) by [David Joseph Guzsik (SeinopSys)](https://github.com/SeinopSys). The original extension redirected YouTube's home page to the subscriptions page at the browser level. UTRehome rewrites this as an MV3 extension that replaces the home feed content in-place using the InnerTube API.

## License

[MIT](LICENSE) — Copyright (c) 2015 David Joseph Guzsik (SeinopSys), 2026 Austin Wisniewski (curbthepain)

## Contributors

<table>
  <tr>
    <td align="center"><a href="https://github.com/SeinopSys"><img src="https://github.com/SeinopSys.png?size=80" width="80" alt="SeinopSys"><br><b>SeinopSys</b></a><br>Original Creator</td>
    <td align="center"><a href="https://github.com/curbthepain"><img src="https://github.com/curbthepain.png?size=80" width="80" alt="curbthepain"><br><b>curbthepain</b></a><br>MV3 Rewrite</td>
  </tr>
</table>
