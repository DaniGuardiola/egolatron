# Egolatron: self-like detector for tweets!

This is a Chrome extension that detects tweets that have been liked by their own authors, and highlights them with shiny self-love medals!

[![Available on the Chrome Webstore](https://developer.chrome.com/webstore/images/ChromeWebStore_BadgeWBorder_v2_496x150.png)](https://chrome.google.com/webstore/detail/egolatron/gncgbgdmioamlfdcliheeepnmgknlekm)

Built for fun by [Dani Guardiola](https://daniguardiola.me) ([@daniguardiolame](https://twitter.com/DaniGuardiola)).

## It stops working randomly, fix it you lazy f%#k!

It's not my fault, it's Twitter and their rate-limiting policy.

If you want to understand why this happens, read on.

# It doesn't work if I'm not logged in!

Yep. Can't do anything about it. Sorry. Again, read below to understand why this is the behavior.

## How it works

The extension will check for new tweets in the current DOM in very short intervals. When it finds new tweets it will analyze them by retrieving the list of users who liked it. The API call being used works with pagination, but this approach works because (as far as I have observed) if the author liked the tweet, it shows in the first page.

The API is used directly from the page's context, reusing the user's (bearer) token that the official Twitter web client has obtained for its own session. This token is retrieved with a hacky but effective method that I came up with after some reverse engineering (feel free to check the code). This approach has a downside: the extension won't work if no user is logged in.

The requested resource (users who liked a tweet) seems to be part of Twitter's v2 API, but I couldn't find any public documentation, so I'm guessing it is an internal resource that only the official clients have access to.

After a tweet has been analyze, the result is stored in memory (the tweet ID and whether it's been 'self-liked' or not). This reduces the volume of calls needed and allows re-rendering the styles if a previously analyzed tweet comes up on screen again. The memory is reset every time the Twitter page is reloaded, but not when navigating inside the app, so it persists through a full session. Of course, this also means that it doesn't take into account any changes that happen after a tweet has been analyzed.

The styles are quite simple, just a red border on top, and a (hand-crafted) medal SVG, animated with CSS for extra-fanciness. The styles won't be applied until the tweet is on-screen (fully visible), even if it has been analyzed previously or while off-screen. The animation will start over if the tweet is re-rendered by the Twitter client, which happens by navigating, or just when scrolling, as the Twitter client implements an infinite list for performance reasons.

## The Twitter rate limit

Twitter rate-limits the requests you can send in a certain period of time. If this limit is exceeded, no more requests can be made until the period resets. In my tests, the limits have been 180 requests for every 15-minute block.

To get detailed information about the rate limit (remaining requests, when the period resets and whether the limit has been reached), enable the stats with the instructions below. Any tweets found during the rate-limited state will be ignored.

## How to look under the hood

Other than reading the code itself, you can enable three debugging options that I baked in. To do this, you need to open the devtools console, and switch to the extension content ("Egolatron" instead of "top" in the dropdown). Then, execute the following:

- For detailed logs: `_egolatron.setLog(true)`
- For detailed stats: `_egolatron.setStats(true)`
- For debug styles: `_egolatron.setDebug(true)`

To disable, pass `false` instead.

Enabling debug styles will also enable logs and stats, overriding their individual settings. The debug styles will show a blue border for tweets that are being analyzed, green for tweets confirmed to not be 'self-liked' and red for 'self-liked' tweets (this will replace the fancy styles with the animated medal).

## How to install directly (in Chromium)

- Download (and extract) or clone this repo.
- Open the extension management page by navigating to `chrome://extensions`.
  - The extension management page can also be opened by clicking on the Chrome menu, hovering over 'More tools' then selecting 'Extensions'.
- Enable developer mode by clicking the toggle switch next to 'Developer mode'.
- Click the 'Load unpacked' button and select the extension directory (`../egolatron/extension/`).

## Where to find the code

Just check the [`extension/content-script.js`](extension/content-script.js) file.

It's all there, well-organized and with many many comments. Maybe too many. Oh, and no dependencies or build process.

## How to thank me for this incredible and necessary contribution to humanity

Star this repo, follow me on Twitter [@daniguardiolame](https://twitter.com/DaniGuardiola) and check out my website: [daniguardiola.me](https://daniguardiola.me)
