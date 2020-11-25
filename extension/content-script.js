// TODO:
// - Switch to new GraphQL API? (doesn't seem to be rate limited at first sight)
// - Improve CSS animation performance (use only transform)
// - Add shadows to the SVG
// - Nicer heart shape
// - Improve specificity of tweet matching to fix #1
// - MutationObserver?
// - Handle errors because the drain the rate limit otherwise
// - Only analyze tweets in / close to viewport?

{
  // parameters
  // ----------

  // tweet detection interval time in milliseconds
  const LOOP_INTERVAL = 100

  // debug flags
  // -----------

  const flags = {}

  const flagSetters = {
    setDebug: value => {
      flags.DEBUG = value
      value
        ? addElementClass(document.body, ego('debug'))
        : removeElementClass(document.body, ego('debug'))
    },
    setLog: value => (flags.LOG_ENABLED = value),
    setStats: value => (flags.LOG_STATS = value)
  }

  // expose setters to (content script) window for curious users
  window._egolatron = flagSetters

  // uncomment line below to enable debug mode
  // flagSetters.setDebug(true)

  // uncomment line below to enable logging (enabled anyway if debug mode is enabled)
  // flagSetters.setLog(true)

  // uncomment line below to enable stats logging (enabled anyway if debug mode is enabled)
  // flagSetters.setStats(true)

  // checks if debug mode is enabled
  function isDebugEnabled () {
    return flags.DEBUG
  }

  // checks if logging (or debug mode) is enabled
  function isLogEnabled () {
    return flags.DEBUG || flags.LOG_ENABLED
  }

  // checks if stats logging (or debug mode) is enabled
  function isStatsLogEnabled () {
    return flags.DEBUG || flags.LOG_STATS
  }

  // state
  // -----

  // statuses for the detected tweets
  const TWEET_STATUS = {
    CHECKING: 0,
    NOT_SELF_LIKED: 1,
    SELF_LIKED: 2
  }

  // the state of the extension
  const state = {
    // the bearer token for the current user session
    bearerToken: null,
    // detected tweets and their current status (one of 'TWEET_STATUS')
    tweets: {},
    // current rate limiting state
    rateLimiting: {
      active: false,
      resetTime: null,
      limit: null,
      remaining: null
    }
  }

  // logging and debugging utils
  // ---------------------------

  // logger function that logs a message if logging is enabled
  function log (msg, force) {
    if (force || isLogEnabled()) console.log(`[egolatron] ${msg}`)
  }

  // logger function that logs a message (as warning) if logging is enabled
  function warn (msg, force) {
    if (force || isLogEnabled()) console.warn(`[egolatron] ${msg}`)
  }

  // computes a few stats fot the current state
  function computeCurrentStats (tweets) {
    const tweetsFound = Object.keys(tweets).length
    const checkingTweets = Object.values(tweets).reduce(
      (acc, value) => (value === TWEET_STATUS.CHECKING ? ++acc : acc),
      0
    )
    const selfLikedTweets = Object.values(tweets).reduce(
      (acc, value) => (value === TWEET_STATUS.SELF_LIKED ? ++acc : acc),
      0
    )
    const notSelfLikedTweets = Object.values(tweets).reduce(
      (acc, value) => (value === TWEET_STATUS.NOT_SELF_LIKED ? ++acc : acc),
      0
    )
    const selfLikedRatio =
      selfLikedTweets / (selfLikedTweets + notSelfLikedTweets) || 0

    return {
      tweetsFound,
      checkingTweets,
      selfLikedTweets,
      notSelfLikedTweets,
      selfLikedRatio
    }
  }

  let lastStatsMsg

  // logs the currents stats to console in a friendly way
  function logCurrentStats (tweets) {
    if (!isStatsLogEnabled()) return
    const {
      tweetsFound,
      checkingTweets,
      selfLikedTweets,
      notSelfLikedTweets,
      selfLikedRatio
    } = computeCurrentStats(tweets)

    // helper that returns an 's' if value is not one (for singular)
    const s = val => (val === 1 ? '' : 's')
    // helper that returns 'is' if one, 'are' otherwise
    const be = val => (val === 1 ? 'is' : 'are')

    let msg = 'Current stats:\n\n'

    if (isRateLimited()) msg += `⚠️ RATE LIMIT EXCEEDED!\n\n`
    const { limit, remaining, resetTime } = state.rateLimiting
    if (resetTime) {
      const pad = n => {
        const s = n + ''
        return s.length < 2 ? '0' + s : s
      }
      const resetDate = new Date(resetTime * 1000)
      const humanResetTime = `${pad(resetDate.getHours())}:${pad(
        resetDate.getMinutes()
      )}:${pad(resetDate.getSeconds())}`
      let remainingString = ''
      if (isRateLimited()) {
        const nowDateSeconds = +(new Date().getTime() / 1000).toFixed(0)
        const resetDateSeconds = +(resetDate.getTime() / 1000).toFixed(0)
        const secondsDiff = resetDateSeconds - nowDateSeconds
        const minutesDiff = +(secondsDiff / 60).toFixed(0)
        const minutesString = minutesDiff ? `${minutesDiff} minutes and ` : ''
        const secondsString = `${secondsDiff % 60} seconds`
        remainingString = ` (in ${minutesString}${secondsString})`
      }
      msg += `Next rate limit reset: ${humanResetTime}${remainingString}\n`
    }
    if (limit !== null && remaining !== null)
      msg += `Rate limit status: ${remaining}/${limit}\n\n`

    msg += `${tweetsFound} tweet${s(tweetsFound)} found so far\n`
    if (checkingTweets)
      msg += `${checkingTweets} tweet${s(checkingTweets)} ${be(
        checkingTweets
      )} still being analyzed\n`
    msg += `${selfLikedTweets} self-liked tweet${s(selfLikedTweets)} found\n`
    msg += `${notSelfLikedTweets} NOT self-liked tweet${s(
      notSelfLikedTweets
    )} found\n`
    msg += `${+(selfLikedRatio * 100).toFixed(
      4
    )}% of analyzed tweets are self-liked`

    if (msg === lastStatsMsg) return // don't repeat the same log twice in a row
    lastStatsMsg = msg
    log(msg, true)
  }

  // misc utils
  // ----------

  // a pretty standard cookie parser
  function parseCookie (string) {
    const object = {}
    const a = string.split(';')
    for (let i = 0; i < a.length; i++) {
      const b = a[i].split('=')
      if (b[0].length > 1 && b[1]) {
        object[b[0].trim()] = b[1]
      }
    }
    return object
  }

  // inserts styles into the page
  function insertStyles (styles) {
    const styleEl = document.createElement('style')
    styleEl.id = ego('styles')
    styleEl.textContent = styles
    document.head.appendChild(styleEl)
  }

  // generates strings with the egolatron prefix and suffix
  function ego (...s) {
    return `__egolatron_${s.join('')}__`
  }

  // checks if an element is fully visible in the page
  function isElementVisible (element) {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= innerHeight
  }

  // adds a class to an element if it doesn't have it already
  function addElementClass (element, className) {
    if (!element.classList.contains(className)) element.classList.add(className)
  }

  // removes a class from an element
  function removeElementClass (element, className) {
    element.classList.remove(className)
  }

  // removes a class from an element if it has it
  function removeElementClass (element, className) {
    if (element.classList.contains(className))
      element.classList.remove(className)
  }

  // styles
  // ------

  // generates the styles
  function getStyles () {
    // helpers
    const cl = (...classes) => `.${ego(...classes)}`
    const tweet = status => `article[${ego('tweet')}="${status}"]`
    const debug = `body${cl('debug')}`
    const notDebug = `body:not(${cl('debug')})`
    const selfLikedTweet = tweet(TWEET_STATUS.SELF_LIKED)
    const hidden = `[${ego('hidden')}="1"]`

    return `
      article {
        transition-property: background-color, box-shadow, border-top !important;
        will-change: border-top;
      }
      
      ${notDebug}      
      ${selfLikedTweet}:not(${hidden}) {
        border-top: solid #ff0000 4px;
        border-radius: 4px;
      }
      
      ${notDebug} 
      ${selfLikedTweet} ${cl('medal')} {
        position: absolute;
        height: 95px;
        top: -95px;
        right: 40px;
        opacity: 1;
        transition: opacity .3s ease-out;
        pointer-events: none;
        will-change: top;
      }
      
      ${notDebug} 
      ${selfLikedTweet}:hover ${cl('medal')},
      ${notDebug} 
      ${selfLikedTweet}:focus ${cl('medal')} {
        opacity: .2;
      }

      ${notDebug} 
      ${selfLikedTweet}:not(${hidden}) ${cl('medal')} {
        top: -20px;
        animation-duration: .5s, 2s;
        animation-name: ${ego('medal_drop_animation')}, ${ego(
      'medal_swing_animation'
    )};
        animation-iteration-count: 1, infinite;
        animation-timing-function: ease-in-out, ease-in-out; 
      }
      
      @keyframes ${ego('medal_drop_animation')} {
          0% {
            top: -95px;
          }
          30% {
            top: -95px;
          }
          75% {
            top: -10px;
          }
          90% {
            top: -25px;
          }
          100% {
            top: -20px;
          }
      }
            
      @keyframes ${ego('medal_swing_animation')} {
          0% {
            transform: rotate(-4deg) translateX(4px);
          }
          50% {
            transform: rotate(4deg) translateX(-4px);
          }
          100% {
            transform: rotate(-4deg) translateX(4px);
          }
      }
      
      /* debug styles */

      ${debug}
      ${tweet(TWEET_STATUS.CHECKING)} {
        border-left: solid blue 4px;
        border-radius: 4px;
      }
      
      ${debug}
      ${selfLikedTweet} {
        border-left: solid red 4px;
        border-radius: 4px;
      }
      
      ${debug}
      ${tweet(TWEET_STATUS.NOT_SELF_LIKED)} {
        border-left: solid green 4px;
        border-radius: 4px;
      }
    `
  }

  // the medal svg
  const SVG_HTML = `
  <svg viewBox="0 0 60.865 167.91" xmlns="http://www.w3.org/2000/svg" class="${ego(
    'medal'
  )}">
    <g transform="translate(-72.273 -13.83)">
      <path fill="#a00" fill-rule="evenodd" d="M116.922 15.531l16.216 9.012-27.221 123.302-16.216-9.012z" />
      <path fill="red" fill-rule="evenodd" d="M72.273 19.63l17.007-5.8 16.788 127.914-17.007 5.799z" />
      <circle cx="97.63" cy="158.41" r="23.332" fill="#ffd42a" />
      <circle cx="97.63" cy="158.41" r="18.165" fill="none" stroke="#d4aa00" stroke-width="3.893" />
      <path
        d="M103.14 147.36a6.673 6.673 0 00-5.51 2.876 6.75 6.75 0 00-5.509-2.876 6.757 6.757 0 00-6.75 6.75c0 9.203 9.566 17.77 12.26 17.77 2.694 0 12.26-8.597 12.26-17.77a6.757 6.757 0 00-6.75-6.75z"
        fill="#e0245e" />
    </g>
  </svg>
  `

  // API and rate limiting
  // ---------------------

  // gets the bearer token with a hacky hack
  async function getBearerToken () {
    log('Obtaining bearer token...')
    // looks for the link tag that loads the main javascript file
    const scriptUrl = document.querySelector(
      'link[href^="https://abs.twimg.com/responsive-web/client-web/main."]'
    ).href
    // fetch the file and get it as text
    const scriptContent = await (await fetch(scriptUrl)).text()
    // extract the bearer token (stored directly in a minified variable inside the file)
    const bearerToken = scriptContent.match(/"(AAAA[a-zA-Z0-9%]*)/)[1]
    log(`Bearer token obtained: ${bearerToken}`)
    return bearerToken
  }

  // rate limit exceeded error code
  // from: https://developer.twitter.com/ja/docs/basics/response-codes
  const RATE_LIMIT_ERROR_CODE = 88

  // checks if rate limit is currently active
  function isRateLimited () {
    return state.rateLimiting.active
  }

  // sets the rate limiting as active
  function activateRateLimited () {
    if (state.rateLimiting.active) return
    state.rateLimiting.active = true
    log(`Rate limit was exceeded!`)
  }

  // updates the rate limit data
  function updateRateLimitData ({ limit, remaining }) {
    if (limit !== null) state.rateLimiting.limit = +limit
    if (remaining !== null) state.rateLimiting.remaining = +remaining
  }

  // updates the rate limit reset time (if higher than previous value)
  function updateRateLimitResetTime (resetTime) {
    if (!resetTime || resetTime <= state.rateLimiting.resetTime) return
    log(
      `Updated rate limiting reset time to: ${resetTime} (was ${state.rateLimiting.resetTime})`
    )
    state.rateLimiting.resetTime = resetTime
  }

  // checks if current time is past the latest rate limit reset time
  // and sets rate limit as inactive if so
  function checkRateLimitResetTime () {
    const now = +(new Date().getTime() / 1000).toFixed(0)
    if (now > state.rateLimiting.resetTime) {
      state.rateLimiting.active = false
    }
  }

  // tweet utils
  // -----------

  // obtains a list of the users who liked a tweet
  // (just the first page, as it always seems to contain the user
  // that posted the tweet if they liked it)
  async function getTweetLikes (id) {
    const url = `https://api.twitter.com/2/timeline/liked_by.json?tweet_id=${id}`
    // get the csrf token needed for the call, that can be found among the cookies
    const csrfToken = parseCookie(document.cookie).ct0
    // prepare the headers
    const headers = {
      authorization: `Bearer ${state.bearerToken}`, // include the bearer token in the header
      'x-csrf-token': csrfToken
    }
    // make the request
    // the 'credentials' option will include the cookies in the request
    const response = await fetch(url, { headers, credentials: 'include' })
    // update the rate limit reset time with the response header
    updateRateLimitResetTime(+response.headers.get('x-rate-limit-reset'))
    // update the rate limit data with the response headers
    updateRateLimitData({
      limit: response.headers.get('x-rate-limit-limit'),
      remaining: response.headers.get('x-rate-limit-remaining')
    })
    // get the result as JSON
    const jsonResult = await response.json()
    if (jsonResult.errors) {
      if (jsonResult.errors.find(({ code }) => code === RATE_LIMIT_ERROR_CODE))
        activateRateLimited()
      throw Error(
        `Errors fetching tweet likes: ${jsonResult.errors
          .map(({ message, code }) => `${code} - ${message}`)
          .join(', ')}`
      )
    }
    // extract and return the screen names of users who liked the tweet
    return Object.values(jsonResult.globalObjects.users).map(
      user => user.screen_name
    )
  }

  // checks if a tweet was liked by a user
  async function checkTweetIsLikedByUser (id, user) {
    // get the likes
    const likes = await getTweetLikes(id)
    // look for the user among the likes
    return !!likes.find(likeUserName => likeUserName === user)
  }

  // sets a tweet element as rendered
  function setElementAttribute (element, name, value) {
    if (element.getAttribute(name) !== '' + value)
      element.setAttribute(name, value)
  }

  // renders the self-liked styles for a tweet element
  function renderSelfLike (element, static) {
    if (isDebugEnabled()) return

    if (!static && !+element.getAttribute(ego('animated'))) {
      setElementAttribute(element, ego('hidden'), 1)
      if (isElementVisible(element)) {
        log(`Tweet is visible now, here's a medal!`)
        setElementAttribute(element, ego('animated'), 1)
        setElementAttribute(element, ego('hidden'), 0)
      }
    }

    const svgExists = !!element.querySelector(`svg.${ego('medal')}`)
    if (!svgExists) element.insertAdjacentHTML('beforeend', SVG_HTML)
  }

  // renders the appropiate styles for a tweet element
  function renderTweet (status, element) {
    if (status === TWEET_STATUS.SELF_LIKED) renderSelfLike(element)
    setElementAttribute(element, ego('tweet'), status)
  }

  // gets all tweets from DOM
  function getDOMTweets () {
    // get all article elements, as they are potential tweets
    const tweetEls = [...document.querySelectorAll('article')]
    return tweetEls
      .map(element => {
        // obtain all links inside the article element
        const links = [...element.querySelectorAll('a')]
        let match
        links.forEach(
          link =>
            (match =
              // tweets contain at least one link matching this regexp pattern
              link.href.match(
                /^https:\/\/twitter\.com\/([a-zA-Z0-9_]+)\/status\/([0-9]+)\/?$/
              ) || match)
        )
        if (!match) return // no match, this is not a tweet
        const user = match[1]
        const id = match[2]
        return { user, id, element }
      })
      .filter(item => item)
  }

  // loop
  // ----

  // checks if a tweet is self-liked, updates the state, and attempts to
  // render the self-liked styles if true
  async function analyzeTweet ({ id, user, element }) {
    if (isRateLimited()) return
    try {
      log(`Analyzing tweet by @${user}: ${id}...`)
      state.tweets[id] = TWEET_STATUS.CHECKING
      renderTweet(state.tweets[id], element)
      const selfLiked = await checkTweetIsLikedByUser(id, user)
      if (selfLiked) {
        log(`❤️ @${user} liked their own tweet! Id: ${id}`)
        state.tweets[id] = TWEET_STATUS.SELF_LIKED
      } else {
        state.tweets[id] = TWEET_STATUS.NOT_SELF_LIKED
      }
      renderTweet(state.tweets[id], element)
    } catch (error) {
      delete state.tweets[id]
      renderTweet(null, element)
      warn(error)
    }
  }

  // updates a tweet
  // - previously detected tweets: render styles
  // - new tweets: check if self-liked
  function updateTweet ({ id, user, element }) {
    // if tweet has been detected previously
    if (state.tweets[id] !== undefined) {
      // render styles
      renderTweet(state.tweets[id], element)
      return
    }
    // else, it is a new  tweet, check it
    analyzeTweet({ id, user, element })
  }

  // checks for tweets and updates them (loop)
  async function updateTweetsLoop (interval) {
    if (isRateLimited()) checkRateLimitResetTime()
    logCurrentStats(state.tweets)
    log(`Checking tweets...`)
    const domTweets = getDOMTweets()
    domTweets.forEach(updateTweet)
    // recursively call this function again after the given interval time
    setTimeout(() => updateTweetsLoop(interval), interval)
  }

  // initialization
  // --------------

  // initializes egolatron
  async function init () {
    // insert the styles into the page
    insertStyles(getStyles())
    // obtain the bearer token and store it in the variable
    state.bearerToken = await getBearerToken()
    // start the loop
    updateTweetsLoop(LOOP_INTERVAL)
  }

  // start it up!
  init()
}
