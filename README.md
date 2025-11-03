# Jellyfin Auditor

This is a simple Deno script that will connect to a running Jellufin API and check it's contents looking for suspect entires.

## Audits
The following audits are performed. The results are markdown files generated into the reports directory. The files are formatted to contain links to the movies/shows in question. All files will be created, even if nothing is found.

- ### Looking for movies with years in the title.
  Sometimes a movie will not be matched but the media find will get poster or other images for it. This makes them look like they are properly matched on casual inspection. This produces two lists, one containing movies that are _probably_ not matched (specifically ones including a year in parenthesis) and another of movies that are _possibly_ unmatched which simple contain any single 4 digit number. This second list often finds false positives since a surprising number of movies and years in the titles.
- ### Looking for television series with suspicious season names.
  I have quite a few items that are not sorted in the way Jellyfin likes having come from a Plex media server that was more forgiving on file names and structure. One common problem I've notices is that if the episodes are not explicitly seasoned with a `s##e##` in the title then they get placed into an "Unknown Season" season, even if the show only contains a single season. This will list those first in the report, then any other season name that looks a bit funky - specifically any that is not "Specials" or "Season #", which often can find other strange things.
- ### Missing Episodes
  While having missing episodes is not itself indicative of a problem it does happen to shows that are not properly organized for Jellyfin. You may see shows that appear to have the correct number of episodes but if you investigate further it'll end up that all the episodes are in the correct season but no episode numbers are attached.
- ### Missing Specials
  Missing specials are even more common that missing episodes and in a lot of cases isn't a big concern but the report can show you places where there might be more to get or that you have in other location entirely that you can move over - for instance if you have a movie from a series as a movie but it also can be attributed as a special for the series. In most cases I move such items into the shows section as the movie listing is already long enough.

More can be added, and probably will as I run across new interesting ways things have found to become broken.

## Running
Presuming you have [Deno](https://docs.deno.com/runtime/) installed and working.

Rename the `.env.example` folder to just `.env` and update accordingly, then you can run `deno run audit` and it will start. It logs what it's doing while it's doing it but the first step, getting all the items from Jellyfin, does take a while especially with large servers.

There are two attributes that can be passed in order to do extra things.
- **--save-raw** Will save the raw data from the server to a ` raw.json` file loaded in the reports directory. This can be used to save querying the server every audit.
- **--load-raw** This will tell it to load the previously mentioned ` raw.json` file in the reports directory.

The default `deno task dev` command is also still there and works as expected however there is an extra `deno task dev-fast` that will use the `--load-raw` command in the process.
