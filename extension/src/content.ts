// Runs on youtube.com in the extension's isolated world. Adds the "Dub VI" button and panel to the player,
// gets the dub made by the backend, and plays each Vietnamese sentence in time with the video.
import { DubUI } from './ui/dubUI';

void new DubUI().init();
