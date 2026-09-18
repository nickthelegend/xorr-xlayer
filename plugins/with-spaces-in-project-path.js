/**
 * Let the iOS build survive a checkout path that contains a space.
 *
 * This repository lives at `/Volumes/Extreme SSD/Projects/xorr-eth`, and Expo's generated
 * "Bundle React Native code and images" build phase ends with an unquoted backtick command:
 *
 *     `"$NODE_BINARY" --print "…/scripts/react-native-xcode.sh"`
 *
 * The substitution expands to a path with a space, the shell word-splits it, and the build dies
 * with `/Volumes/Extreme: No such file or directory` — nowhere near the actual cause. Quoting the
 * substitution executes the one path it produced:
 *
 *     "$("$NODE_BINARY" --print "…/scripts/react-native-xcode.sh")"
 *
 * `ios/` is generated and gitignored, so the fix has to live here rather than in the project file;
 * a config plugin re-applies it on every prebuild. The sibling breakages in `expo-constants` and
 * `expo`'s own bundling script are upstream source, so those are handled by `patches/` instead —
 * see `patches/expo-constants+57.0.17.patch` and `patches/expo+57.0.20.patch`.
 */
const { withXcodeProject } = require('expo/config-plugins');

/** The generated pbxproj stores shell scripts escaped, so honour whichever form we are handed. */
function quoteSubstitution(shellScript) {
  const quote = shellScript.includes('\\"') ? '\\"' : '"';
  return shellScript.replace(
    /`([^`]*react-native-xcode\.sh[^`]*)`/,
    (_, inner) => `${quote}$(${inner})${quote}`,
  );
}

module.exports = function withSpacesInProjectPath(config) {
  return withXcodeProject(config, (cfg) => {
    const phases = cfg.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    for (const phase of Object.values(phases)) {
      if (phase && typeof phase.shellScript === 'string') {
        phase.shellScript = quoteSubstitution(phase.shellScript);
      }
    }
    return cfg;
  });
};
