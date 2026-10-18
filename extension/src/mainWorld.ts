// Runs in the page's own JavaScript world so it can read YouTube's player and its caption requests.
// It only answers the content script; it never talks to the network except to fetch captions from youtube.com.
import { serveCaptions } from './adapters/youtube/pageCaptions';

serveCaptions();
