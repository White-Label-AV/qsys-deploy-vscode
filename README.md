# Q-SYS Lua Script Deployment Extension for VS Code

This extension allows you to edit Lua scripts in VS Code that are designed to run on a Q-SYS Core and automatically deploy them to either a running Q-SYS Core or a running instance of Q-SYS Designer in emulation mode. Big thanks to [Patrick Gilligan](https://www.youtube.com/@patrickgil_dev) for the inspiration for this extension.

## Features

- **Multi-Core Deployment**: Deploy scripts to multiple Q-SYS Cores simultaneously with optimized connection pooling
- **Quick Deploy**: Fast deployment to pre-configured targets with a single keyboard shortcut
- **Interactive Selection**: Choose specific cores and components when deploying with multi-select support
- **Connection Optimization**: Intelligent connection pooling and timeout handling for reliable deployments
- **Auto-Deploy**: Automatically deploy scripts on save (configurable per script or globally)
- **Component Validation**: Validate component types before deployment to prevent errors
- **Authentication Support**: Connect to cores with username/password authentication
- **Comprehensive Logging**: Detailed debug output for troubleshooting deployments

## Keyboard Shortcuts

- **Ctrl+Alt+D**: Deploy Current Script (with interactive selection)
- **Ctrl+Alt+Shift+D**: Deploy to All (deploy to all configured targets)
- **Ctrl+Alt+Q**: Quick Deploy (deploy to quick deploy targets only)

All shortcuts work when editing Lua files.

## New in Version 0.4

### Enhanced Multi-Core Support

- **Connection Pooling**: Reuse connections to the same core for multiple deployments
- **Optimized Deployment**: Group deployments by core to minimize connection overhead
- **Timeout Handling**: Configurable connection timeouts with graceful error handling
- **Batch Operations**: Deploy to multiple cores and components in a single operation

### Quick Deploy Feature

- Configure specific targets for rapid deployment with `quickDeploy: true`
- Ideal for development workflows where you frequently deploy to the same targets
- Separate command and keyboard shortcut for instant deployment

### Improved Configuration

- **Multiple Core Names**: Use `coreNames` array instead of single `coreName` for multi-core targets
- **Backward Compatibility**: Existing `coreName` configurations continue to work
- **Connection Timeout**: Configurable timeout settings for unreliable networks
- **Per-Script Auto-Deploy**: Override global auto-deploy settings per script

### Better User Experience

- **Enhanced Selection UI**: Improved multi-select with "Select All" functionality
- **Deployment Results**: Comprehensive reporting of successful, failed, and skipped deployments
- **Status Bar Integration**: Real-time connection status display
- **Error Handling**: Clear error messages and graceful failure handling

## Requirements

- Visual Studio Code 1.75.0 or higher
- A running Q-SYS Core or Q-SYS Designer in emulation mode
- Text Controller components that have script access set to "External" or "All"

## Extension Settings

This extension contributes the following settings:

### Core Configuration

- `qsys-deploy.cores`: Array of Q-SYS Core configurations
- `qsys-deploy.connectionTimeout`: Connection timeout in milliseconds (default: 10000)

### Script Configuration

- `qsys-deploy.scripts`: Array of script deployment configurations
- `qsys-deploy.autoDeployOnSave`: Global auto-deploy on save setting (default: false)

## Configuration Examples

### Basic Multi-Core Setup

```json
{
  "qsys-deploy": {
    "cores": [
      {
        "name": "Main Auditorium",
        "ip": "192.168.1.100",
        "username": "admin",
        "password": "pass"
      },
      {
        "name": "Secondary Room",
        "ip": "192.168.1.101"
      },
      {
        "name": "Q-SYS Designer Emulation",
        "ip": "127.0.0.1"
      }
    ],
    "connectionTimeout": 15000,
    "autoDeployOnSave": false
  }
}
```

### Advanced Script Mapping with Quick Deploy

```json
{
  "qsys-deploy": {
    "scripts": [
      {
        "filePath": "scripts/main-control.lua",
        "targets": [
          {
            "coreNames": ["Main Auditorium", "Secondary Room"],
            "components": ["MainController", "SecondaryController"],
            "quickDeploy": true
          },
          {
            "coreNames": ["Q-SYS Designer Emulation"],
            "components": ["TestController"],
            "quickDeploy": false
          }
        ],
        "autoDeployOnSave": true
      },
      {
        "filePath": "scripts/utility.lua",
        "targets": [
          {
            "coreNames": ["Main Auditorium"],
            "components": ["UtilityScript"]
          }
        ]
      }
    ]
  }
}
```

### Legacy Configuration (Still Supported)

```json
{
  "qsys-deploy": {
    "scripts": [
      {
        "filePath": "scripts/legacy-script.lua",
        "targets": [
          {
            "coreName": "Main Auditorium",
            "components": ["LegacyController"]
          }
        ]
      }
    ]
  }
}
```

## Commands

This extension provides the following commands:

- **Q-SYS: Deploy Current Script** (`Ctrl+Alt+D`): Deploy the current script with interactive core and component selection
- **Q-SYS: Deploy to All** (`Ctrl+Alt+Shift+D`): Deploy to all configured targets for the current script
- **Q-SYS: Quick Deploy** (`Ctrl+Alt+Q`): Deploy to targets marked with `quickDeploy: true`
- **Q-SYS: Test Core Connection**: Test connection to a Q-SYS Core
- **Q-SYS: Show Debug Output**: Show the debug output panel with detailed logs

## Migration Guide from v0.3.x

### Configuration Changes

1. **Multiple Cores**: Replace `coreName` with `coreNames` array for multi-core deployments:

   ```json
   // Old (v0.3.x)
   {
     "coreName": "Main Core",
     "components": ["Controller1"]
   }
   
   // New (v0.4.0)
   {
     "coreNames": ["Main Core", "Backup Core"],
     "components": ["Controller1"]
   }
   ```

2. **Quick Deploy**: Add `quickDeploy` flag to targets for rapid deployment:

   ```json
   {
     "coreNames": ["Development Core"],
     "components": ["TestController"],
     "quickDeploy": true
   }
   ```

3. **Connection Timeout**: Add timeout configuration for unreliable networks:

   ```json
   {
     "qsys-deploy": {
       "connectionTimeout": 15000
     }
   }
   ```

### New Features Available

- Use `Ctrl+Alt+Q` for quick deployment to development targets
- Use `Ctrl+Alt+Shift+D` to deploy to all configured targets at once
- Enable per-script auto-deploy with `autoDeployOnSave: true` in script configuration

### Backward Compatibility

- All existing v0.3.x configurations continue to work without changes
- `coreName` is automatically migrated to `coreNames` internally
- No breaking changes to existing workflows

## Usage

### Basic Deployment

1. Open a Lua script file in VS Code
2. Configure your cores and script mappings in settings.json
3. Press `Ctrl+Alt+D` to deploy with interactive selection
4. Choose cores and components from the multi-select dialogs

### Quick Development Workflow

1. Configure your development targets with `quickDeploy: true`
2. Press `Ctrl+Alt+Q` for instant deployment to development cores
3. Use `Ctrl+Alt+Shift+D` to deploy to all targets when ready for production

### Auto-Deploy Setup

1. Enable `autoDeployOnSave: true` globally or per script
2. Scripts automatically deploy when saved
3. Perfect for rapid development iterations

## Connection Optimization and Timeout Handling

### Connection Pooling

- Connections to the same core are reused across multiple deployments
- Reduces connection overhead when deploying to multiple components
- Automatic cleanup when deployments complete

### Timeout Configuration

- Default timeout: 10 seconds
- Configurable via `connectionTimeout` setting (1-60 seconds)
- Graceful handling of timeout errors with clear reporting

### Error Handling

- Failed connections don't stop other deployments
- Clear distinction between connection failures and deployment failures
- Comprehensive reporting of successful, failed, and skipped deployments

## Debugging

If you encounter issues with deployment, use the debug output panel:

1. Run `Q-SYS: Show Debug Output` to open the debug panel
2. Try deploying a script or testing a connection
3. Review detailed logs including:
   - Connection attempts and timeouts
   - Authentication processes
   - Component validation
   - QRC protocol communication
   - Deployment results and errors

## QRC Protocol

This extension uses the QRC protocol to communicate with Q-SYS Core. For more information:

- [QRC Overview](https://q-syshelp.qsc.com/content/External_Control_APIs/QRC/QRC_Overview.htm)
- [QRC Commands](https://q-syshelp.qsc.com/content/External_Control_APIs/QRC/QRC_Commands.htm)

## License

This extension is licensed under the MIT License.
