# @logspot/web

Logspot SDK for browser applications built with React, Next.js, Angular, etc.

## Installation

`npm install @logspot/web`

or

`yarn add @logspot/web`

## Usage

### Init


```js
import Logspot from '@logspot/web';

Logspot.init({ publicKey: 'YOUR_PUBLIC_KEY' });
```

### Track

```js
Logspot.track({ 
    event: 'UserSubscribed', 
    userId: 'john@doe.com', 
    metadata: { additionalData: '123' } 
});
```