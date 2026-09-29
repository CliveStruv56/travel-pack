# trips/

Put real trip files here (`*.travelpack.json`, exported from the app via More → Share → Save trip file,
or a backup). **Everything in this folder except this README is git-ignored**, because trip files contain
booking references, and this repository is public. `npm run check` fails if one is ever committed.

Make a one-tap setup link for your phone:

    npm run link -- https://clivestruv56.github.io/travel-pack/ trips/october-2026.travelpack.json
