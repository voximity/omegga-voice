# omegga-voice

A proximity voice chat plugin for Omegga.

After installing, users can connect to your server by going to `https://<your ip>:<port>`. By default, the port is 7778.

## Usage

Install with `omegga install gh:voximity/voice`.

Navigate to the plugin directory (`cd plugins/omegga-voice`) and
install the dependencies (`npm i`).

All at once: `omegga install gh:voximity/voice && cd plugins/omegga-voice && npm i`

## Config

By default, the port used is 7778. You will need to forward an extra port for
the web server and voice signaller to tunnel through. You can change this from
Omegga's config.

## Credits

voximity - creator, maintainer
[Meshiest](https://github.com/Meshiest) - Omegga, initial version of this project
