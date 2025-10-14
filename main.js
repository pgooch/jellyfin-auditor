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

// Authenticate with Jellyfin
console.log(`Authenticating ${JF_Auth.username} with Jellyfin server at ${JF_URI}...`);
if( JF_Auth.username === null || JF_Auth.password === null ){
  throw new Error('Unable to authenticate, no username/password provided.')
}
await QueryJellyfin('/Users/AuthenticateByName', {'username': JF_Auth.username, 'pw': JF_Auth.password})

// Load up absolutely everything since were gonna need most all of it for one check or another
const totalRecords = Math.min(LIMIT, await QueryJellyfin('/Items?Recursive=true&Limit=0').then(r => r.TotalRecordCount));
console.log(`Loading all ${ totalRecords } items from the server, this could take a while...`);
const JellyfinItemsRaw = await QueryJellyfin('/Items?Recursive=true'+(LIMIT===Infinity?"":'&Limit='+LIMIT)).then(r => r.Items);

// Preprocess it a bit, getting indexes grouped by type so we can process one at a time.
console.log(`Pre-processing items...`)
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
ensureDir(SAVE_PATH);
console.log(`Starting audits...`)



/// Check for movies that appear to have hears in the title
const CheckMoviesWithYear = new Promise(( resolve, _reject )=>{
  console.log('   Checking for movies with years in the title...')
  let _output = '';
  _output += `# Movies with Years in Title\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n`

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

  _output += `\n## Probably Unmatched\n`;
  probablyUnmatched.sort(collator.compare).forEach(( movieLink ) => {
    _output += ` - ${movieLink}\n`;
  })

  _output += `\n## Potentially Unmatched\n`;
  potentiallyUnmatched.sort(collator.compare).forEach(( movieLink ) => {
    _output += ` - ${movieLink}\n`;
  })

  Deno.writeTextFileSync(SAVE_PATH+"movies-with-years-in-title.md", _output);
  resolve();
})



// Check for questionable seasons
const CheckSuspiciousSeasons = new Promise(( resolve, _reject )=>{
  console.log('   Checking for seasons that don\'t look quite right...')
  let _output = '';
  _output += `# Television Series with Suspicious Seasons\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n`

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

  Deno.writeTextFileSync(SAVE_PATH+"television-series-with-suspicious-seasons.md", _output);
  resolve();
})



// Check for missing episodes
const CheckMissingEpisodes = new Promise(( resolve, _reject )=>{
  console.log('   Checking for missing episodes...')
  let _output = '';
  _output += `# Television Series with Missing Episodes\n`;
  _output += `_Audit generated ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} against ${totalRecords} items in server located at ${JF_URI}._\n`

  const missingEpisodesByShow = {};

  JellyfinTypes.Episode.forEach(( episodeId ) => {
    const episode = JellyfinItems[episodeId];
    if( episode.Container === undefined ){
      const seriesLink = `\n## [${JellyfinItems[episodeId].SeriesName}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].SeriesId}&serverId=${JellyfinItems[episodeId].ServerId})\n` 
      const episodeLink = `- [${JellyfinItems[episodeId].Name}](${JF_URI}/web/#/details?id=${JellyfinItems[episodeId].Id}&serverId=${JellyfinItems[episodeId].ServerId})\n` 

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

  Deno.writeTextFileSync(SAVE_PATH+"television-series-with-missing-episodes.md", _output);
  resolve();
})



// Wrap things up
Promise.all([CheckMoviesWithYear, CheckSuspiciousSeasons, CheckMissingEpisodes]).then(()=>{
  console.log('Audits complete.')
})
