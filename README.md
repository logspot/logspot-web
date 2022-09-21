# @logspot/web

Logspot SDK for browser applications built with React, Next.js, Angular, etc.

## Installation

`npm install @logspot/web`

or

`yarn add @logspot/web`

## Usage

### Init

```js
import Logspot from "@logspot/web";

Logspot.init({ publicKey: "YOUR_PUBLIC_KEY", cookiesDisabled: true });
```

- `publicKey` - project public key
- `cookiesDisabled` - use this property to disable anonymous user tracking
- `enableAutoPageviews` - enable auto tracking of pageviews (default: true)
- `enableAutoClicks` - enable auto capture of user clicks (default: false)
- `externalApiUrl` - provide here API proxy url
- `onLoad` - use this function to perform actions when Logspot is loaded. E.g. register super properties before initial pageview

### Track

```js
Logspot.track({
  event: "UserSubscribed",
  notify: true,
  message: "john@doe.com has subscribed",
  userId: "john@doe.com",
  metadata: { additionalData: "123" },
});
```

### Pageview

```js
Logspot.pageview({
  userId: "john@doe.com",
  metadata: { additionalData: "123" },
});
```

### Register

```js
Logspot.register({
  email: "john@doe.com",
  authenticated: true,
  project: "SuperStartup",
});
```
