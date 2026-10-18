// Language detection for a document's text, and the login session token kept
// in the Keychain. Speech comes from the server.

#import <NaturalLanguage/NaturalLanguage.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>

@interface VttsSpeech : NSObject <RCTBridgeModule>
@end

@implementation VttsSpeech

RCT_EXPORT_MODULE(VttsSpeech)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/** BCP-47 language of `text` (e.g. "en", "vi"), or null when unsure. */
RCT_EXPORT_METHOD(detectLanguage:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NLLanguage language = [NLLanguageRecognizer dominantLanguageForString:text];
  resolve(language && ![language isEqualToString:NLLanguageUndetermined] ? language : [NSNull null]);
}

/** The Keychain item that holds the session token. */
/** The Keychain item that holds the session token. */
static NSDictionary *SessionQuery(void)
{
  return @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"vtts-reader-session",
    (__bridge id)kSecAttrAccount : @"session",
  };
}

/** The saved session token, or null when logged out. */
RCT_EXPORT_METHOD(loadSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableDictionary *query = [SessionQuery() mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    resolve([NSNull null]);
    return;
  }
  if (status != errSecSuccess) {
    reject(@"keychain", [NSString stringWithFormat:@"Keychain read failed (%d)", (int)status], nil);
    return;
  }
  NSData *data = (__bridge_transfer NSData *)result;
  resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}

RCT_EXPORT_METHOD(saveSession:(NSString *)token
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SecItemDelete((__bridge CFDictionaryRef)SessionQuery());
  NSMutableDictionary *item = [SessionQuery() mutableCopy];
  item[(__bridge id)kSecValueData] = [token dataUsingEncoding:NSUTF8StringEncoding];
  item[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlock;
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  if (status != errSecSuccess) {
    reject(@"keychain", [NSString stringWithFormat:@"Keychain write failed (%d)", (int)status], nil);
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(clearSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SecItemDelete((__bridge CFDictionaryRef)SessionQuery());
  resolve(nil);
}

@end
