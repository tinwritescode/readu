// On-device speech through iOS system voices (AVSpeechSynthesizer).
// JS side: src/adapters/speech/SystemSpeechEngine.ts

#import <AVFoundation/AVFoundation.h>
#import <NaturalLanguage/NaturalLanguage.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface VttsSpeech : RCTEventEmitter <RCTBridgeModule, AVSpeechSynthesizerDelegate>
@end

@implementation VttsSpeech {
  AVSpeechSynthesizer *_synth;
  NSMapTable<AVSpeechUtterance *, NSString *> *_utteranceIds;
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE(VttsSpeech)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (instancetype)init
{
  if (self = [super init]) {
    _synth = [AVSpeechSynthesizer new];
    _synth.delegate = self;
    _utteranceIds = [NSMapTable weakToStrongObjectsMapTable];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"onStart", @"onRange", @"onFinish", @"onCancel", @"onPause", @"onContinue" ];
}

- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving { _hasListeners = NO; }

- (void)emit:(NSString *)name utterance:(AVSpeechUtterance *)utterance extra:(NSDictionary *)extra
{
  NSString *utteranceId = [_utteranceIds objectForKey:utterance];
  if (!_hasListeners || utteranceId == nil) {
    return;
  }
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithDictionary:extra ?: @{}];
  body[@"utteranceId"] = utteranceId;
  [self sendEventWithName:name body:body];
}

static NSString *QualityName(AVSpeechSynthesisVoiceQuality quality)
{
  switch (quality) {
    case AVSpeechSynthesisVoiceQualityPremium: return @"premium";
    case AVSpeechSynthesisVoiceQualityEnhanced: return @"enhanced";
    default: return @"default";
  }
}

RCT_EXPORT_METHOD(getVoices:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableArray *voices = [NSMutableArray new];
  for (AVSpeechSynthesisVoice *voice in [AVSpeechSynthesisVoice speechVoices]) {
    // Novelty voices (Albert, Bubbles, Zarvox…) can't read a document; keeping them
    // would also let one win the default pick for English.
    if (@available(iOS 17.0, *)) {
      if (voice.voiceTraits & AVSpeechSynthesisVoiceTraitIsNoveltyVoice) continue;
    }
    NSLocale *locale = [NSLocale localeWithLocaleIdentifier:voice.language];
    NSString *code = locale.languageCode ?: voice.language;
    // The language named in itself ("Tiếng Việt"), the region in the user's language.
    NSString *languageName = [locale localizedStringForLanguageCode:code] ?: code;
    NSString *region = locale.countryCode;
    NSString *regionName = region ? [NSLocale.currentLocale localizedStringForCountryCode:region] : nil;
    [voices addObject:@{
      @"id" : voice.identifier,
      @"name" : voice.name,
      @"language" : voice.language,
      @"languageName" : languageName.localizedCapitalizedString,
      @"regionName" : regionName ?: voice.language,
      @"quality" : QualityName(voice.quality),
    }];
  }
  resolve(voices);
}

/** BCP-47 language of `text` (e.g. "en", "vi"), or null when unsure. */
RCT_EXPORT_METHOD(detectLanguage:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NLLanguage language = [NLLanguageRecognizer dominantLanguageForString:text];
  resolve(language && ![language isEqualToString:NLLanguageUndetermined] ? language : [NSNull null]);
}

RCT_EXPORT_METHOD(speak:(NSString *)text
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSError *sessionError = nil;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  [session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeSpokenAudio options:0 error:&sessionError];
  [session setActive:YES error:&sessionError];

  AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
  NSString *voiceId = options[@"voiceId"];
  if ([voiceId isKindOfClass:[NSString class]]) {
    AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithIdentifier:voiceId];
    if (voice == nil) {
      reject(@"E_VOICE", [NSString stringWithFormat:@"Voice not installed: %@", voiceId], nil);
      return;
    }
    utterance.voice = voice;
  }
  NSNumber *rate = options[@"rate"];
  if ([rate isKindOfClass:[NSNumber class]]) {
    utterance.rate = MAX(AVSpeechUtteranceMinimumSpeechRate, MIN(AVSpeechUtteranceMaximumSpeechRate, rate.floatValue));
  }
  NSNumber *pitch = options[@"pitch"];
  if ([pitch isKindOfClass:[NSNumber class]]) {
    utterance.pitchMultiplier = pitch.floatValue;
  }

  NSString *utteranceId = [NSUUID UUID].UUIDString;
  [_utteranceIds setObject:utteranceId forKey:utterance];
  [_synth speakUtterance:utterance];
  resolve(utteranceId);
}

RCT_EXPORT_METHOD(pause)
{
  [_synth pauseSpeakingAtBoundary:AVSpeechBoundaryWord];
}

RCT_EXPORT_METHOD(resume)
{
  [_synth continueSpeaking];
}

RCT_EXPORT_METHOD(stop)
{
  [_synth stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
}

#pragma mark - AVSpeechSynthesizerDelegate

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didStartSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onStart" utterance:utterance extra:nil];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
    willSpeakRangeOfSpeechString:(NSRange)characterRange
                       utterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onRange"
       utterance:utterance
           extra:@{@"location" : @(characterRange.location), @"length" : @(characterRange.length)}];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onFinish" utterance:utterance extra:nil];
  [_utteranceIds removeObjectForKey:utterance];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onCancel" utterance:utterance extra:nil];
  [_utteranceIds removeObjectForKey:utterance];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didPauseSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onPause" utterance:utterance extra:nil];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didContinueSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emit:@"onContinue" utterance:utterance extra:nil];
}

@end
