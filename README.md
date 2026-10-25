# Type and Seek

A hidden-role guessing game for 3 to 10 players, each on their own device.

- 🔎 **The seeker** types questions to everyone (15 by default; the host can change it), then gets **one guess** at who the hider is.
- 🙈 **The hider** has to answer every question **truthfully**, without getting caught.
- 🎭 **The fakies** know who the hider is. They can lie (or tell the truth) to confuse the seeker and protect the hider.

Roles are picked at random when the host starts. Everyone else's answers to a question show up, with names, once they've all answered.
The seeker can guess any time, and has to guess after the last question. Right guess: the seeker wins. Wrong guess: the hider and fakies win.

If the seeker or hider leaves, the game ends. If a fakie leaves, the game carries on without them. If the host leaves, the room closes.

## Files

- `index.html`: screens and styles.
- `typeandseek.js`: the game and the online rooms (Firebase Realtime Database, `typeandseek/rooms/<CODE>` in the `kvgames` project).

To run it locally, serve the folder with any static file server, for example `python3 -m http.server`.
