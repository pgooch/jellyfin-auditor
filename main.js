import "jsr:@std/dotenv/load";
import { format } from "https://deno.land/std/datetime/mod.ts";
import { ensureDir } from "jsr:@std/fs/ensure-dir";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Configuration, URI, UN, and PW can be updated from .env
 */
const JF_URI = Deno.env.get('JF_URI') ?? 'http://localhost:8096';
const JF_Auth = {
  username: Deno.env.get('JF_Auth_UN') ?? null,
  password: Deno.env.get('JF_Auth_PW') ?? null,
  accessToken: '',
  deviceId: crypto.randomUUID(),
}
const SAVE_PATH = './reports/';
const LIMIT = Infinity; // Set to Infinity for all, auditors expect to see everything so reduction is only useful for faster dev



/**
 * QueryJellyfin
 * @param requestPath The Jellyfin endpoint you are looking for, see https://api.jellyfin.org/
 * @param data A JSON object to be sent to jellyfin. This also determines if it's POST or GET, any data passed will make it POST, otherwise it's get
 * @returns Response JSON object or success, null when errored
 */
async function QueryJellyfin( requestPath = '/', data = false ){
  const requestUri = JF_URI+requestPath;
  const requestData = {
    method: data ? "POST" : "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `MediaBrowser Client="Jellyfin Media Auditor", Device="Deno Script", DeviceId="${JF_Auth.deviceId}", Version="10", Token=${JF_Auth.accessToken}`,
    },
    body: data ? JSON.stringify(data) : null
  }

  const response = await fetch(requestUri, requestData);

  if( response.status === 200 ){
    let wasAuthenticationRequest = false;
    const jsonResponse = await response.json();

    if( requestPath === '/Users/AuthenticateByName' ){
      wasAuthenticationRequest = true;
      JF_Auth.accessToken = jsonResponse.AccessToken;
      JF_Auth.deviceId = jsonResponse.SessionInfo.DeviceId;
    }

    return {
      wasAuthenticationRequest: wasAuthenticationRequest,
      status: response.status,
      statusText: response.statusText,
      ...jsonResponse
    };
  }else{
    console.error('There was an error with a Jellfin API request');
    console.error('Request: ', requestUri,requestData);
    console.error('Response:', response);
  }
}



/**
 * Start the actual scripin'
 */
// Make sure we have a place to save stuff
ensureDir(SAVE_PATH);

// Check if we are loading data from a file instead
let JellyfinItemsRaw;
if( Deno.args.includes("--load-raw") ){
  console.log(`Attempting to load saved raw dump...`);
  try {
    JellyfinItemsRaw = JSON.parse(Deno.readTextFileSync(SAVE_PATH+" raw.json"));
    console.log('Found '+JellyfinItemsRaw.length+' records...')
  } catch (error) {
    console.error("Error reading saved raw JSON file.", error);
  }
}else{

  // Authenticate with Jellyfin
  console.log(`Authenticating ${JF_Auth.username} with Jellyfin server at ${JF_URI}...`);
  if( JF_Auth.username === null || JF_Auth.password === null ){
    throw new Error('Unable to authenticate, no username/password provided.')
  }
  await QueryJellyfin('/Users/AuthenticateByName', {'username': JF_Auth.username, 'pw': JF_Auth.password})

  // Load up absolutely everything since were gonna need most all of it for one check or another
  const totalRecords = Math.min(LIMIT, await QueryJellyfin('/Items?Recursive=true&Limit=0').then(r => r.TotalRecordCount));
  console.log(`Loading all ${ totalRecords } items from the server, this could take a while...`);
  JellyfinItemsRaw = await QueryJellyfin('/Items?Recursive=true'+(LIMIT===Infinity?"":'&Limit='+LIMIT)).then(r => r.Items);
}

// Check if we're saving a copy of that data for later use
if( Deno.args.includes("--save-raw") ){
  console.log('Saving JSON dump of raw data...')
  Deno.writeTextFileSync(SAVE_PATH+" raw.json", JSON.stringify(JellyfinItemsRaw));
}

// Preprocess it a bit, getting indexes grouped by type so we can process one at a time.
console.log(`Pre-processing items...`)
const totalRecords = JellyfinItemsRaw.length;
const JellyfinItems = {};
const JellyfinTypes = {};

JellyfinItemsRaw.forEach(( item )=>{
  JellyfinItems[ item.Id ] = item
  if( JellyfinTypes[item.Type] === undefined ){
    JellyfinTypes[item.Type] = [];
  }
  JellyfinTypes[item.Type].push(item.Id);
})



// Note we';'ve started the main audit
console.log(`Starting audits...`)

/// Check for movies that appear to have hears in the title
const CheckMoviesWithYear = new Promise(( resolve, _reject )=>{
  console.log('   Checking for movies with years in the title...')
  let _output = '';
  _output += `# Movies with Years in Title\n\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n\n`
  _output += `These are movies that appear to have a year in the title which is often indicitive of an unmatched movie. They are broken up into Probably, where the year is in parenthesis, and possible when it's just a year. It's not uncommon for movies to have a year in the title so things get placed into the possible category overzealously.\n\n`

  const probablyUnmatched = []
  const potentiallyUnmatched = []
  JellyfinTypes.Movie.forEach(( MovieId ) => {
    const movieName = JellyfinItems[MovieId].Name;
    const movieId = JellyfinItems[MovieId].Id;
    const serverId = JellyfinItems[MovieId].ServerId;
    if( movieName.match(/\(\d\d\d\d\)/gm)){
      probablyUnmatched.push( `[${movieName}](${JF_URI}/web/#/details?id=${movieId}&serverId=${serverId})` )
    }else if( movieName.match(/\d\d\d\d/gm)){
      potentiallyUnmatched.push( `[${movieName}](${JF_URI}/web/#/details?id=${movieId}&serverId=${serverId})` )
    }
  })

  _output += `## Probably Unmatched\n`;
  probablyUnmatched.sort(collator.compare).forEach(( movieLink ) => {
    _output += ` - ${movieLink}\n`;
  })

  _output += `\n## Potentially Unmatched\n`;
  potentiallyUnmatched.sort(collator.compare).forEach(( movieLink ) => {
    _output += ` - ${movieLink}\n`;
  })

  Deno.writeTextFileSync(SAVE_PATH+"movies with years in title.md", _output);
  resolve();
})



// Check for questionable seasons
const CheckSuspiciousSeasons = new Promise(( resolve, _reject )=>{
  console.log('   Checking for seasons that don\'t look quite right...')
  let _output = '';
  _output += `# Television Series with Suspicious Seasons\n\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n\n`
  _output += `These are shows with episodes in either an unknown season or in a season that is not "Season #" or "Specials". This is indicative of the shows file structure not being correct and Jellyfin being unable to determine what season the upsides are for or a show with extras in it that are not properly places for Jellyfin.\n\n`

  const questionableSeasons = {}
  JellyfinTypes.Season.forEach(( SeasonId ) => {
    const seasonName = JellyfinItems[SeasonId].Name;
    if( !seasonName.match(/^Season \d+/gm) && seasonName!='Specials'){
      if( questionableSeasons[seasonName] === undefined ){
        questionableSeasons[seasonName] = []
      }
      const seriesId = JellyfinItems[SeasonId].SeriesId;
      questionableSeasons[seasonName].push(  `- [${JellyfinItems[seriesId].Name}](${JF_URI}/web/#/details?id=${JellyfinItems[seriesId].Id}&serverId=${JellyfinItems[seriesId].ServerId})\n`  )
    }
  })

  const seasons = Object.keys(questionableSeasons).sort(collator.compare)
  if( seasons.indexOf('Season Unknown') > -1 ){
    delete seasons[seasons.indexOf('Season Unknown')];
    seasons.unshift("Season Unknown")
  }

  seasons.forEach(( season ) => {
    if( season !== null ){
      _output += `\n## ${season}\n`
    }
    questionableSeasons[season].sort(collator.compare).forEach(( seriesLink )=>{
      _output += seriesLink
    })
  })

  Deno.writeTextFileSync(SAVE_PATH+"television series with suspicious seasons.md", _output);
  resolve();
})



// Check for missing episodes
const CheckMissingEpisodes = new Promise(( resolve, _reject )=>{
  console.log('   Checking for missing episodes...')
  let _output = '';
  _output += `# Television Series with Missing Episodes\n\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n\n`
  _output += `These are shows with missing episodes during their regular seasons. While this can be just because they have not been properly released, or that you just quit following the show it is also a sign that episodes are nor being properly captured causing them to show up in a seasons but as unassigned episodes.\n\n`

  const missingEpisodesByShow = {};

  JellyfinTypes.Episode.forEach(( episodeId ) => {
    const episode = JellyfinItems[episodeId];
    if( episode.Container === undefined && episode.SeasonName.match(/^Season \d+/gm) ){
      const seriesLink =  `- ### [${JellyfinItems[episodeId].SeriesName}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].SeriesId}&serverId=${JellyfinItems[episodeId].ServerId})\n` 
      const seasonLink =  `  - #### [${JellyfinItems[episodeId].SeasonName}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].SeasonId}&serverId=${JellyfinItems[episodeId].ServerId})\n`;
      const episodeLink = `    - [${JellyfinItems[episodeId].Name}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].Id}&serverId=${JellyfinItems[episodeId].ServerId})\n` 

      if( missingEpisodesByShow[seriesLink] === undefined ){
        missingEpisodesByShow[seriesLink] = {};
      }
      if( missingEpisodesByShow[seriesLink][seasonLink] === undefined ){
        missingEpisodesByShow[seriesLink][seasonLink] = [];
      }
      missingEpisodesByShow[seriesLink][seasonLink].push(episodeLink)

    }
  })

  Object.keys(missingEpisodesByShow).sort(collator.compare).forEach(( seriesLink ) => {
    _output += seriesLink
     Object.keys(missingEpisodesByShow[seriesLink]).sort(collator.compare).forEach(( seasonLink ) => {
      _output += seasonLink
      missingEpisodesByShow[seriesLink][seasonLink].sort(collator.compare).forEach(( episodeLink ) => {
        _output += episodeLink
      })
     })
  })

  Deno.writeTextFileSync(SAVE_PATH+"television series with missing episodes.md", _output);
  resolve();
})






// Check for missing specaials
// TODO - make this smarter not just a copy of the above with a single character changed.
const CheckMissingSpecials = new Promise(( resolve, _reject )=>{
  console.log('   Checking for missing specials...')
  let _output = '';
  _output += `# Television Series with Missing Specials\n\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n\n`
  _output += `These are shows with missing specials or other items that are not part of their regular seasons. This is the partner file to the missing episodes during regular seasons. Missing specials are far more common and less likely to impact viewing but they can still be indicative of an issue, especially on series where you'd expect that you have it all.\n\n`

  const missingEpisodesByShow = {};

  JellyfinTypes.Episode.forEach(( episodeId ) => {
    const episode = JellyfinItems[episodeId];
    if( episode.Container === undefined && !episode.SeasonName.match(/^Season \d+/gm) ){
      const seriesLink =  `- ### [${JellyfinItems[episodeId].SeriesName}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].SeriesId}&serverId=${JellyfinItems[episodeId].ServerId})\n` 
      const episodeLink = `    - [${JellyfinItems[episodeId].Name}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].Id}&serverId=${JellyfinItems[episodeId].ServerId})\n` 

      if( missingEpisodesByShow[seriesLink] === undefined ){
        missingEpisodesByShow[seriesLink] = [];
      }
      missingEpisodesByShow[seriesLink].push(episodeLink)

    }
  })

  Object.keys(missingEpisodesByShow).sort(collator.compare).forEach(( seriesLink ) => {
    _output += seriesLink
      missingEpisodesByShow[seriesLink].sort(collator.compare).forEach(( episodeLink ) => {
        _output += episodeLink
     })
  })

  Deno.writeTextFileSync(SAVE_PATH+"television series with missing specials.md", _output);
  resolve();
})



// Wrap things up
Promise.all([CheckMoviesWithYear, CheckSuspiciousSeasons, CheckMissingEpisodes, CheckMissingSpecials]).then(()=>{
  console.log('Audits complete.')
})
