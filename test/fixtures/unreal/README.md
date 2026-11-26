These logs are constructed by hand from the formats UnrealBuildTool, UnrealHeaderTool,
MSVC, AutomationTool and the editor print (UE 5.3 to 5.5). Unreal Engine cannot run in
CI, so they are not captured from a real build. Each pair differs only in what changes
between real runs: action counts, order of parallel output, timings, line numbers and
engine install paths. Captured logs from real projects are welcome as extra fixtures.
