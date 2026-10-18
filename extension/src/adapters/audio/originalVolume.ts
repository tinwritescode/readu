/**
 * Turns the video's own sound down while dubbing. The video is routed once through a Web Audio gain, so the
 * level never fights YouTube, which rewrites video.volume from its own slider. If the element cannot be routed
 * (another extension already captured it), video.volume is used instead.
 */
export class OriginalVolume {
  private static graphs = new WeakMap<HTMLVideoElement, GainNode>();
  private gain: GainNode | null;
  private level = 1;
  /** The viewer's own volume, when falling back to video.volume. */
  private viewerVolume: number | null = null;

  constructor(private video: HTMLVideoElement) {
    this.gain = OriginalVolume.route(video);
    if (!this.gain) video.addEventListener('volumechange', this.onVolumeChange);
  }

  private static route(video: HTMLVideoElement): GainNode | null {
    const known = OriginalVolume.graphs.get(video);
    if (known) return known;
    // Without a user gesture on the page the context would start suspended and silence the video.
    if (!navigator.userActivation?.hasBeenActive) return null;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      ctx.createMediaElementSource(video).connect(gain).connect(ctx.destination);
      // A routed video plays through this context, so it must run whenever the video does.
      video.addEventListener('play', () => void ctx.resume());
      void ctx.resume();
      OriginalVolume.graphs.set(video, gain);
      return gain;
    } catch {
      return null;
    }
  }

  set(level: number) {
    this.level = level;
    if (this.gain) {
      this.gain.gain.value = level;
      return;
    }
    this.viewerVolume ??= this.video.volume;
    this.video.volume = this.viewerVolume * level;
  }

  restore() {
    if (this.gain) {
      this.gain.gain.value = 1;
      return;
    }
    this.video.removeEventListener('volumechange', this.onVolumeChange);
    if (this.viewerVolume !== null) this.video.volume = this.viewerVolume;
    this.viewerVolume = null;
  }

  // A volume this code did not set came from the viewer or YouTube: take it as the full level and lower it again.
  private onVolumeChange = () => {
    if (this.viewerVolume === null || Math.abs(this.video.volume - this.viewerVolume * this.level) < 0.01) return;
    this.viewerVolume = this.video.volume;
    this.video.volume = this.viewerVolume * this.level;
  };
}
