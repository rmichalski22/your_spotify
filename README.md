![Build CI](https://github.com/Yooooomi/your_spotify/workflows/Nightly%20build%20CI/badge.svg)
![Release CI](https://github.com/Yooooomi/your_spotify/workflows/Release%20CI/badge.svg)
[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/donate/?hosted_button_id=BLAPT49PK9A8G)

<p align='center'>
  <img width="100%" src="https://user-images.githubusercontent.com/17204739/154752226-c2215a51-e20e-4ade-ac63-42c5abb25240.png">
</p>

# Your Spotify

**YourSpotify** is a self-hosted application that tracks what you listen and offers you a dashboard to explore statistics about it!
It's composed of a web server which polls the Spotify API every now and then and a web application on which you can explore your statistics.

## Deploy this fork with Docker Compose

This deployment builds the server and web images from this repository. The upstream `docker-compose-example.yml` pulls community images and does not include this fork's import fixes.

1. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app and register the exact redirect URI `${API_ENDPOINT}/oauth/spotify/callback`. For the default same-machine setup, that is `http://127.0.0.1:8080/oauth/spotify/callback`. Spotify [does not accept `localhost`](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
2. Clone this fork and make local configuration files:

   ```sh
   git clone https://github.com/rmichalski22/your_spotify.git
   cd your_spotify
   cp .env.example .env
   cp docker-compose-personal.example.yml docker-compose-personal.yml
   ```

3. Open `.env` and enter the app's **Client ID** as `SPOTIFY_PUBLIC` and **Client Secret** as `SPOTIFY_SECRET`. Keep `.env` private; Git ignores it. To use host ports **8089** and **3010** on the same machine, also set:

   ```dotenv
   SERVER_PORT=8089
   CLIENT_PORT=3010
   API_ENDPOINT=http://127.0.0.1:8089
   CLIENT_ENDPOINT=http://127.0.0.1:3010
   ```

   Register `http://127.0.0.1:8089/oauth/spotify/callback` in Spotify for that setup. Docker still uses ports 8080 and 3000 *inside* the containers. If you open the site from another device, use reachable HTTPS URLs for `API_ENDPOINT` and `CLIENT_ENDPOINT`, point your reverse proxy at the chosen host ports, and register the HTTPS API callback in Spotify.
4. Build and start the containers:

   ```sh
   docker compose -f docker-compose-prod.yml -f docker-compose-personal.yml up -d --build
   docker compose -f docker-compose-prod.yml -f docker-compose-personal.yml logs -f app web
   ```

Open the URL set as `CLIENT_ENDPOINT` on the Docker host. To stop the app, run `docker compose -f docker-compose-prod.yml -f docker-compose-personal.yml down`. The MongoDB data is stored in `./db_data`; if moving an existing installation, point the `mongo` volume in `docker-compose-prod.yml` at your existing database directory before starting.

# Table of contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Using docker](#using-docker-compose)
  - [Installing locally](#installing-locally-not-recommended)
  - [Environment](#environment)
  - [Advanced CORS settings](#advanced-cors-settings)
- [Creating the Spotify application](#creating-the-spotify-application)
- [Importing past history](#importing-past-history)
  - [Supported import methods](#supported-import-methods)
    - [Privacy data](#privacy-data)
    - [Full privacy data](#full-privacy-data-recommended)
  - [Troubleshoot](#troubleshoot)
- [FAQ](#faq)
- [External guides](#external-guides)
- [Contributing](#contributing)
- [Sponsoring](#sponsoring)

# Prerequisites

1. You have to own a Spotify application ID that you can create through their [dashboard](https://developer.spotify.com/dashboard/applications).
2. You need to provide the **Server** environment the **public** AND **secret** key of the application (cf. [Installation](#installation)).
3. Register the exact callback URL in the Spotify Developer Dashboard.

> A tutorial is available at the end of this readme.

# Installation

## Using `docker-compose`

Follow [Deploy this fork with Docker Compose](#deploy-this-fork-with-docker-compose) above. The production Compose file builds both application images from this checkout.

## Installing locally (not recommended)

You can follow the instructions [here](https://github.com/Yooooomi/your_spotify/blob/master/LOCAL_INSTALL.md). Note that you will still have to do the steps below.

## Environment

| Key | Default value (if any) | Description |
| :--- | :--- | :--- |
| CLIENT_ENDPOINT       | REQUIRED | The endpoint of your web application |
| API_ENDPOINT          | REQUIRED | The endpoint of your server |
| SERVER_PORT           | 8080 | Host port mapped to the server container's port 8080; update `API_ENDPOINT` to match |
| CLIENT_PORT           | 3000 | Host port mapped to the web container's port 3000; update `CLIENT_ENDPOINT` to match |
| SPOTIFY_PUBLIC        | REQUIRED | The public key of your Spotify application (cf [Creating the Spotify Application](#creating-the-spotify-application)) |
| SPOTIFY_SECRET        | REQUIRED | The secret key of your Spotify application (cf [Creating the Spotify Application](#creating-the-spotify-application)) |
| TIMEZONE              | Europe/Paris | The timezone of your stats, only affects read requests since data is saved with UTC time |
| MONGO_ENDPOINT        | mongodb://mongo:27017/your_spotify | The endpoint of the Mongo database, where **mongo** is the name of your service in the compose file |
| PROMETHEUS_USERNAME             | _not defined_ | Prometheus basic auth username (see [here](https://github.com/Yooooomi/your_spotify/tree/master/apps/server#prometheus)) |
| PROMETHEUS_PASSWORD             | _not defined_ | Prometheus basic auth password |
| LOG_LEVEL             | info | The log level, debug is useful if you encouter any bugs |
| CORS                  | _not defined_ | List of comma-separated origin allowed (not required; defaults to CLIENT_ENDPOINT) |
| COOKIE_VALIDITY_MS    | 30d | Validity time of the authentication cookie and token, following [this pattern](https://github.com/vercel/ms) |
| SPOTIFY_REQUESTS_PER_30_SECONDS | 10 | Conservative app-wide Web API request budget in Spotify's rolling 30-second window. Keep this low for development-mode apps; Spotify does not publish a fixed limit. |
| MAX_IMPORT_CACHE_SIZE | Infinite | The maximum element in the cache when importing data from an outside source, more cache means less requests to Spotify, resulting in faster imports |
| MONGO_NO_ADMIN_RIGHTS | false | Do not ask for admin right on the Mongo database |
| PORT                  | 8080 | The port of the server, **do not** modify if you're using docker |
| FRAME_ANCESTORS       | _not defined_ | Sites allowed to frame the website, comma separated list of URLs (`i-want-a-security-vulnerability-and-want-to-allow-all-frame-ancestors` to allow every website) |

### Large history imports and Spotify limits

Spotify measures Web API rate limits over a [rolling 30-second window](https://developer.spotify.com/documentation/web-api/concepts/rate-limits), but does not publish a fixed call count for development-mode apps. The server defaults to 10 requests per 30 seconds across all users and keeps two of those slots available for login and token requests. A Spotify rate-limit response pauses the shared queue for `Retry-After` and reduces its request budget. Set `SPOTIFY_REQUESTS_PER_30_SECONDS` lower if your app still receives rate-limit responses.

Development-mode apps also have [separate per-developer quota buckets](https://developer.spotify.com/documentation/web-api/concepts/quota-modes). If Spotify reports `QUOTA_EXCEEDED`, the import stops without retrying the exhausted bucket; the failed import can be retried from Settings after quota is available again. Imports with many unique tracks can take hours because [development-mode bulk track, album, and artist lookups are unavailable](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

## Advanced CORS settings

**Manually specifying CORS configuration is not required for typical deployments.**  
99.9% of users do not need to worry about this, it is handled automatically.

If your use case requires the backend to be used from multiple frontend origins, you can manually adjust the `CORS` variable.
For example, a value of `origin1,origin2` will allow `origin1` and `origin2`.

# Creating the Spotify Application

For **YourSpotify** to work you need to provide a Spotify application **public** AND **secret** to the server environment.
To do so, you need to create a **Spotify application** [here](https://developer.spotify.com/dashboard/applications).

1. Click on **Create app**.
2. Fill out all the information.
3. Set the redirect URI to your **server** URL plus `/oauth/spotify/callback`, for example `http://127.0.0.1:8080/oauth/spotify/callback` for a same-machine install. Use HTTPS for a non-loopback URL.
4. Check **Web API**
5. Check **I understand and agree**
6. Hit **Settings** at the top right corner
7. Copy the **Client ID** and **Client Secret** into your private `.env` file as `SPOTIFY_PUBLIC` and `SPOTIFY_SECRET`, respectively.
8. Once you have created your application, Spotify wants you to register the users that will be able to access the application. (You don't need to do that for the account that created the application)
   1. Click the **User Management** button
   2. Enter the required information, a name and the email the user's Spotify account has been created with.

# Importing past history

By default, **YourSpotify** will only retrieve data for the past 24 hours once registered. This is a technical limitation. However, you can import previous data by two ways.

The import process uses cache to limit requests to the Spotify API. By default, the cache size is unlimited, but you can limit is with the `MAX_IMPORT_CACHE_SIZE` env variable in the **server**.

## Supported import methods

### Privacy data

> Takes a maximum of 5 days.
> Only gets you the last year of history.

- Request your **privacy data** at Spotify to have access to your history for the past year [here](https://www.spotify.com/us/account/privacy/).
- Head to the **Settings** page and choose the **Account data** method.
- Input your files starting with `StreamingHistoryX.json`.
- Start your import.

### Full privacy data (recommended)

> Takes a maximum of 30 days.
> Gets you the whole history since the creation of your account.

- Request your **Full privacy data** to have access to your history data since the creation of the account [here](https://www.spotify.com/us/account/privacy/).
- Head to the **Settings** page and choose the **Extended streaming history** method.
- Input your files starting with `Streaming_History_Audio_YYYY-YYYY_X.json`.
- Start your import.

## Troubleshoot

An import can fail:
- If the server reboots.
- If a request fails 10 times in a row.

A failed import can be retried in the **Settings** page. Be sure to clean your failed imports if you do not want to retry it as it will remove the files used for it.

It is safer to import data at account creation. Though **YourSpotify** detects duplicates, some may still be inserted.

# FAQ

> How can I block new registrations?

From an admin account, go to the **Settings** page and hit the **Disable new registrations** button.

> Songs don't seem to synchronize anymore.

This can happen if you revoked access on your Spotify account. To re-sync the songs, go to settings and hit the **Relog to Spotify** button.

> The web application is telling me it cannot retrieve global preferences.

This means that your web application can't connect to the backend. Check that your **API_ENDPOINT** env variable is reachable from the device you're using the platform from.

> A specific user does not use the application in the same timezone as the server, how can I set a specific timezone for him?

Any user can set his proper timezone in the settings, it will be used for any computed statistics. The timezone of the device will be used for everything else, such as song history.

# External guides

- [BreadNet](https://breadnet.co.uk/your-spotify-2022) installation tutorial

# Contributing

If you have any issue or any idea that could make the project better, feel free to open an [issue](https://github.com/Yooooomi/your_spotify/issues/new/choose). I'd love to hear about new ideas or bugs you are encountering.

# Sponsoring

I work on this project on my spare time and try to fix issues as soon as I can. If you feel generous and think this project and my investment are worth a few cents, you can consider sponsoring it with the button on the right, many thanks.

