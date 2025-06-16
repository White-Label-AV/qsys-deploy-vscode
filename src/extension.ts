import * as vscode from 'vscode';
import * as net from 'net';

// Interface definitions
interface QSysCore {
    name: string;
    ip: string;
    username?: string;
    password?: string;
}

interface DeploymentTarget {
    coreNames?: string[]; // New array format for multiple cores
    coreName?: string; // Legacy field for backward compatibility
    components: string[];
    quickDeploy?: boolean;
}

interface ScriptMapping {
    filePath: string;
    targets: DeploymentTarget[];
    autoDeployOnSave?: boolean;
}

interface Component {
    Name: string;
    ID: string;
    Type: string;
}

// Enhanced error system
enum ErrorCategory {
    CONNECTION_TIMEOUT = "Connection Timeout",
    AUTHENTICATION_FAILED = "Authentication Failed",
    NETWORK_UNREACHABLE = "Network Unreachable",
    COMPONENT_NOT_FOUND = "Component Not Found",
    INVALID_COMPONENT_TYPE = "Invalid Component Type",
    PERMISSION_DENIED = "Permission Denied",
    SCRIPT_TOO_LARGE = "Script Too Large",
    CORE_BUSY = "Core Busy",
    INVALID_CREDENTIALS = "Invalid Credentials",
    PORT_BLOCKED = "Port Blocked",
    CORE_OFFLINE = "Core Offline",
    SCRIPT_SYNTAX_ERROR = "Script Syntax Error",
    UNKNOWN_ERROR = "Unknown Error"
}

interface DeploymentContext {
    operation: string; // "connecting", "authenticating", "validating", "deploying"
    core?: QSysCore;
    component?: string;
    startTime: Date;
    attemptNumber: number;
    filePath?: string;
}

interface EnhancedError {
    category: ErrorCategory;
    title: string;
    message: string;
    details: string;
    suggestions: string[];
    context: DeploymentContext;
    originalError?: Error;
    timestamp: Date;
}

// QRC Client for communicating with Q-SYS Core
class QrcClient {
    private socket: net.Socket | null = null;
    private responseCallbacks: Map<number, (response: any) => void> = new Map();
    private messageId: number = 1;
    private buffer: string = '';
    private outputChannel: vscode.OutputChannel;
    private connectionTimeout: number;
    private isConnected: boolean = false;

    constructor(private ip: string, private port: number = 1710, outputChannel: vscode.OutputChannel, timeout: number = 10000) {
        this.outputChannel = outputChannel;
        this.connectionTimeout = timeout;
    }

    // Connect to the Q-SYS Core with timeout handling and cancellation support
    public connect(cancellationToken?: DeploymentCancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.isConnected && this.socket) {
                this.outputChannel.appendLine(`Already connected to Q-SYS Core at ${this.ip}`);
                resolve();
                return;
            }

            // Check if already cancelled
            if (cancellationToken?.isCancelled) {
                reject(new Error('Connection cancelled before starting'));
                return;
            }

            this.outputChannel.appendLine(`Connecting to Q-SYS Core at ${this.ip}:${this.port} (timeout: ${this.connectionTimeout}ms)...`);
            this.socket = new net.Socket();
            
            // Set up connection timeout
            const timeoutId = setTimeout(() => {
                this.outputChannel.appendLine(`Connection timeout after ${this.connectionTimeout}ms`);
                if (this.socket) {
                    this.socket.destroy();
                }
                reject(new Error(`Connection timeout after ${this.connectionTimeout}ms`));
            }, this.connectionTimeout);
            
            // Set up cancellation handler
            let cancelled = false;
            const cancelHandler = () => {
                if (!cancelled) {
                    cancelled = true;
                    clearTimeout(timeoutId);
                    if (this.socket) {
                        this.socket.destroy();
                    }
                    this.isConnected = false;
                    this.outputChannel.appendLine(`Connection to ${this.ip} cancelled by user`);
                    reject(new Error('Connection cancelled by user'));
                }
            };

            if (cancellationToken) {
                cancellationToken.onCancelled(cancelHandler);
            }
            
            // Use a raw buffer to handle binary data properly
            let rawBuffer = Buffer.alloc(0);
            
            this.socket.on('data', (data: Buffer) => {
                if (!cancelled) {
                    // Log the raw data as hex for debugging
                    this.outputChannel.appendLine(`Received raw data (${data.length} bytes): ${this.bufferToHexString(data)}`);
                    
                    // Append to our raw buffer
                    rawBuffer = Buffer.concat([rawBuffer, data]);
                    
                    // Process the buffer
                    this.processRawBuffer(rawBuffer).then(remainingBuffer => {
                        rawBuffer = remainingBuffer;
                    });
                }
            });
            
            this.socket.on('error', (err) => {
                if (!cancelled) {
                    clearTimeout(timeoutId);
                    this.isConnected = false;
                    this.outputChannel.appendLine(`Connection error: ${err.message}`);
                    reject(err);
                }
            });
            
            this.socket.on('close', () => {
                if (!cancelled) {
                    this.isConnected = false;
                    this.outputChannel.appendLine(`Connection closed to ${this.ip}`);
                }
            });
            
            this.socket.connect(this.port, this.ip, () => {
                if (!cancelled) {
                    clearTimeout(timeoutId);
                    this.isConnected = true;
                    this.outputChannel.appendLine(`Connected to Q-SYS Core at ${this.ip}`);
                    resolve();
                }
            });
        });
    }

    // Close the connection
    public disconnect(): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.isConnected = false;
    }

    // Check if client is connected
    public isClientConnected(): boolean {
        return this.isConnected && this.socket !== null;
    }
    
    // Convert buffer to hex string for debugging
    private bufferToHexString(buffer: Buffer): string {
        let result = '';
        for (let i = 0; i < buffer.length; i++) {
            const byte = buffer[i];
            // Show printable ASCII characters as-is, others as hex
            if (byte >= 32 && byte <= 126) {
                result += String.fromCharCode(byte);
            } else if (byte === 0) {
                result += '\\0'; // NULL character
            } else if (byte === 10) {
                result += '\\n'; // Newline
            } else if (byte === 13) {
                result += '\\r'; // Carriage return
            } else {
                result += `\\x${byte.toString(16).padStart(2, '0')}`;
            }
        }
        return result;
    }

    // Process the raw buffer and extract JSON messages
    private async processRawBuffer(buffer: Buffer): Promise<Buffer> {
        let currentPosition = 0;
        let messageStart = 0;
        
        // Scan through the buffer looking for message boundaries
        while (currentPosition < buffer.length) {
            // Look for NULL character or newline as message delimiter
            if (buffer[currentPosition] === 0 || buffer[currentPosition] === 10) {
                if (currentPosition > messageStart) {
                    // Extract the message
                    const messageBuffer = buffer.slice(messageStart, currentPosition);
                    const messageStr = messageBuffer.toString().trim();
                    
                    if (messageStr.length > 0) {
                        const delimiterType = buffer[currentPosition] === 0 ? "NULL" : "newline";
                        this.outputChannel.appendLine(`Found message with ${delimiterType} delimiter at position ${currentPosition}`);
                        this.outputChannel.appendLine(`Message content: ${messageStr}`);
                        
                        // Process the message
                        await this.processMessage(messageStr);
                    }
                }
                
                // Move past this delimiter to start of next message
                messageStart = currentPosition + 1;
            }
            
            currentPosition++;
        }
        
        // Return any unprocessed data
        return buffer.slice(messageStart);
    }
    
    // Process a JSON message
    private async processMessage(message: string): Promise<void> {
        try {
            // Check if the message starts with a valid JSON character
            if (message.startsWith('{') || message.startsWith('[')) {
                this.outputChannel.appendLine(`Parsing JSON message: ${message}`);
                const response = JSON.parse(message);
                
                // Handle responses to our commands (with ID)
                if (response.id && this.responseCallbacks.has(response.id)) {
                    this.outputChannel.appendLine(`Found callback for ID ${response.id}`);
                    const callback = this.responseCallbacks.get(response.id);
                    if (callback) {
                        callback(response);
                        this.responseCallbacks.delete(response.id);
                    }
                } 
                // Handle unsolicited messages (like EngineStatus)
                else if (response.method) {
                    this.outputChannel.appendLine(`Received unsolicited message: ${response.method}`);
                    // You might want to handle specific unsolicited messages here
                }
            } else {
                this.outputChannel.appendLine(`Skipping non-JSON message: ${message}`);
            }
        } catch (err) {
            this.outputChannel.appendLine(`Error parsing QRC response: ${err}`);
            console.error('Error parsing QRC response:', err);
        }
    }

    // Send a command to the Q-SYS Core
    public sendCommand(method: string, params: any[] | object = []): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                const error = 'Not connected to Q-SYS Core';
                this.outputChannel.appendLine(`Error: ${error}`);
                reject(new Error(error));
                return;
            }
            
            const id = this.messageId++;
            const command = {
                jsonrpc: '2.0',
                method,
                params,
                id
            };
            
            const commandStr = JSON.stringify(command);
            this.outputChannel.appendLine(`Sending command: ${commandStr}`);
            
            this.responseCallbacks.set(id, (response) => {
                this.outputChannel.appendLine(`Received response for command ${id}: ${JSON.stringify(response)}`);
                if (response.error) {
                    reject(new Error(response.error.message || 'Unknown error'));
                } else {
                    resolve(response.result);
                }
            });
            
            // Send with NULL terminator instead of newline, as per QRC protocol
            this.socket.write(commandStr + '\0');
        });
    }

    // Login to the Q-SYS Core
    public async login(username: string, password: string): Promise<void> {
        try {
            await this.sendCommand('Logon', {
                User: username,
                Password: password
            });
        } catch (err) {
            throw new Error(`Authentication failed: ${err}`);
        }
    }

    // Get all components
    public async getComponents(): Promise<Component[]> {
        try {
            const result = await this.sendCommand('Component.GetComponents');
            this.outputChannel.appendLine(`GetComponents result: ${JSON.stringify(result)}`);
            
            // The result is directly an array of components
            if (Array.isArray(result)) {
                this.outputChannel.appendLine(`Result is an array with ${result.length} components`);
                return result;
            }
            
            // Or it might be in a Components property
            if (result.Components && Array.isArray(result.Components)) {
                this.outputChannel.appendLine(`Result has Components array with ${result.Components.length} components`);
                return result.Components;
            }
            
            // If neither, log an error and return empty array
            this.outputChannel.appendLine(`Unexpected GetComponents response format: ${JSON.stringify(result)}`);
            return [];
        } catch (err) {
            this.outputChannel.appendLine(`Error getting components: ${err}`);
            throw new Error(`Failed to get components: ${err}`);
        }
    }

    // Set script content for a component
    public async setScript(componentName: string, scriptContent: string): Promise<void> {
        try {
            // Format the command according to the QRC protocol specification
            const params = {
                Name: componentName,
                Controls: [
                    {
                        Name: "code",
                        Value: scriptContent
                    }
                ]
            };
            
            this.outputChannel.appendLine(`Setting script for component "${componentName}" with params: ${JSON.stringify(params)}`);
            await this.sendCommand('Component.Set', params);
        } catch (err) {
            this.outputChannel.appendLine(`Error setting script: ${err}`);
            throw new Error(`Failed to set script: ${err}`);
        }
    }

    // Get script content from a component
    public async getScript(componentName: string): Promise<string> {
        try {
            // Format the command according to the QRC protocol specification
            const params = {
                Name: componentName,
                Controls: ["code"]
            };
            
            this.outputChannel.appendLine(`Getting script from component "${componentName}"`);
            const result = await this.sendCommand('Component.Get', params);
            
            // Extract the script content from the response
            if (result && result.Controls && result.Controls.length > 0) {
                const codeControl = result.Controls.find((c: any) => c.Name === "code");
                if (codeControl && codeControl.Value) {
                    return codeControl.Value;
                }
            }
            
            this.outputChannel.appendLine(`No script content found in response: ${JSON.stringify(result)}`);
            return '';
        } catch (err) {
            this.outputChannel.appendLine(`Error getting script: ${err}`);
            throw new Error(`Failed to get script: ${err}`);
        }
    }
}

// Connection Pool Manager for reusing connections to the same core
class ConnectionPoolManager {
    private connections: Map<string, QrcClient> = new Map();
    private outputChannel: vscode.OutputChannel;
    private connectionTimeout: number;

    constructor(outputChannel: vscode.OutputChannel, timeout: number = 10000) {
        this.outputChannel = outputChannel;
        this.connectionTimeout = timeout;
    }

    // Get or create a connection for a core with cancellation support
    async getConnection(core: QSysCore, cancellationToken?: DeploymentCancellationToken): Promise<QrcClient> {
        const coreKey = `${core.ip}:${core.name}`;
        
        // Check if cancelled before starting
        cancellationToken?.throwIfCancelled();
        
        let client = this.connections.get(coreKey);
        
        if (client && client.isClientConnected()) {
            this.outputChannel.appendLine(`Reusing existing connection to ${core.name} (${core.ip})`);
            return client;
        }

        // Create new connection
        this.outputChannel.appendLine(`Creating new connection to ${core.name} (${core.ip})`);
        client = new QrcClient(core.ip, 1710, this.outputChannel, this.connectionTimeout);
        
        try {
            await client.connect(cancellationToken);
            
            // Check cancellation after connection
            cancellationToken?.throwIfCancelled();
            
            // Authenticate if credentials are provided
            if (core.username && core.password) {
                this.outputChannel.appendLine('Authenticating...');
                await client.login(core.username, core.password);
                this.outputChannel.appendLine('Authentication successful');
                
                // Check cancellation after authentication
                cancellationToken?.throwIfCancelled();
            }
            
            this.connections.set(coreKey, client);
            return client;
        } catch (error) {
            client.disconnect();
            throw error;
        }
    }

    // Close a specific connection
    closeConnection(core: QSysCore): void {
        const coreKey = `${core.ip}:${core.name}`;
        const client = this.connections.get(coreKey);
        
        if (client) {
            this.outputChannel.appendLine(`Closing connection to ${core.name} (${core.ip})`);
            client.disconnect();
            this.connections.delete(coreKey);
        }
    }

    // Close all connections
    closeAllConnections(): void {
        this.outputChannel.appendLine('Closing all connections...');
        for (const [coreKey, client] of this.connections) {
            client.disconnect();
        }
        this.connections.clear();
    }

    // Get connection count
    getConnectionCount(): number {
        return this.connections.size;
    }
}

// Deployment cancellation token for stopping deployments
class DeploymentCancellationToken {
    private _isCancelled: boolean = false;
    private _onCancelledCallbacks: (() => void)[] = [];
    
    get isCancelled(): boolean {
        return this._isCancelled;
    }
    
    cancel(): void {
        if (!this._isCancelled) {
            this._isCancelled = true;
            this._onCancelledCallbacks.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    console.error('Error in cancellation callback:', error);
                }
            });
        }
    }
    
    onCancelled(callback: () => void): void {
        this._onCancelledCallbacks.push(callback);
        if (this._isCancelled) {
            callback();
        }
    }
    
    throwIfCancelled(): void {
        if (this._isCancelled) {
            throw new Error('Operation was cancelled');
        }
    }
}

// Deployment result interface
interface DeploymentResult {
    success: boolean;
    core: QSysCore;
    componentName: string;
    error?: string;
    skipped?: boolean;
    skipReason?: string;
    cancelled?: boolean;
}

// Extension activation
export function activate(context: vscode.ExtensionContext) {
    console.log('Q-SYS Deploy extension is now active');
    
    // Create output channel for debugging
    const outputChannel = vscode.window.createOutputChannel('Q-SYS Deploy');
    outputChannel.appendLine('Q-SYS Deploy extension activated');
    context.subscriptions.push(outputChannel);
    
    // Status bar item to show current connection status
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = 'Q-SYS: Not Connected';
    statusBarItem.command = 'qsys-deploy.testConnection';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    // Command to show debug output
    const showDebugOutputCommand = vscode.commands.registerCommand('qsys-deploy.showDebugOutput', () => {
        outputChannel.show();
    });
    context.subscriptions.push(showDebugOutputCommand);
    
// Get extension settings with backward compatibility migration
    function getSettings() {
        const config = vscode.workspace.getConfiguration('qsys-deploy');
        const rawScripts = config.get<ScriptMapping[]>('scripts', []);
        
        // Migrate legacy coreName to coreNames array
        const migratedScripts = rawScripts.map(script => ({
            ...script,
            targets: script.targets.map(target => {
                // If target has legacy coreName but no coreNames, migrate it
                if (target.coreName && !target.coreNames) {
                    return {
                        ...target,
                        coreNames: [target.coreName],
                        // Keep coreName for backward compatibility but mark as legacy
                        coreName: target.coreName
                    };
                }
                // If target has both, ensure coreNames takes precedence
                if (target.coreNames && target.coreNames.length > 0) {
                    return {
                        ...target,
                        coreNames: target.coreNames
                    };
                }
                // If target only has coreNames, use as-is
                return target;
            })
        }));
        
        return {
            autoDeployOnSave: config.get<boolean>('autoDeployOnSave', false),
            cores: config.get<QSysCore[]>('cores', []),
            scripts: migratedScripts,
            connectionTimeout: config.get<number>('connectionTimeout', 10000)
        };
    }

    // Create connection pool manager
    const settings = getSettings();
    const connectionPool = new ConnectionPoolManager(outputChannel, settings.connectionTimeout);
    
    // Clean up connections when extension is deactivated
    context.subscriptions.push({
        dispose: () => {
            connectionPool.closeAllConnections();
        }
    });
    
    // Update status bar
    function updateStatusBar(connected: boolean, coreName?: string) {
        if (connected && coreName) {
            statusBarItem.text = `Q-SYS: Connected to ${coreName}`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBarItem.text = 'Q-SYS: Not Connected';
            statusBarItem.backgroundColor = undefined;
        }
    }

    // Find script mapping for a file
    function findScriptMappings(filePath: string): { script: ScriptMapping, targets: Array<{ core: QSysCore, componentNames: string[] }> } | undefined {
        const settings = getSettings();
        const normalizedFilePath = vscode.workspace.asRelativePath(filePath);
        
        // Find the script mapping
        const scriptMapping = settings.scripts.find(script => {
            const normalizedMappingPath = vscode.workspace.asRelativePath(script.filePath);
            return normalizedFilePath === normalizedMappingPath;
        });
        
        if (!scriptMapping) {
            return undefined;
        }
        
        // Find all cores and components for this script
        const targets: Array<{ core: QSysCore, componentNames: string[] }> = [];
        
        for (const target of scriptMapping.targets) {
            // Handle both new coreNames array and legacy coreName
            const coreNamesToProcess = target.coreNames || (target.coreName ? [target.coreName] : []);
            
            for (const coreName of coreNamesToProcess) {
                const core = settings.cores.find(c => c.name === coreName);
                if (core) {
                    targets.push({
                        core,
                        componentNames: target.components
                    });
                }
            }
        }
        
        if (targets.length === 0) {
            return undefined;
        }
        
        return { script: scriptMapping, targets };
    }
    
    // Validate multiple components at once for a core
    async function validateComponents(client: QrcClient, componentNames: string[]): Promise<{[componentName: string]: {valid: boolean, error?: string, type?: string}}> {
        const results: {[componentName: string]: {valid: boolean, error?: string, type?: string}} = {};
        
        try {
            outputChannel.appendLine(`Validating ${componentNames.length} components...`);
            
            // Get all components from the core once
            const components = await client.getComponents();
            outputChannel.appendLine(`Retrieved ${components.length} components from the core`);
            
            const validTypes = ['device_controller_script', 'control_script_2', 'scriptable_controls', 'device_controller_proxy'];
            
            // Validate each component against the retrieved list
            for (const componentName of componentNames) {
                // Find the component by Name or ID
                const matchedComponent = components.find(comp =>
                    comp.Name === componentName || comp.ID === componentName
                );
                
                if (!matchedComponent) {
                    outputChannel.appendLine(`Component "${componentName}" not found in the list of components`);
                    results[componentName] = {
                        valid: false,
                        error: `Component "${componentName}" not found`
                    };
                    continue;
                }
                
                outputChannel.appendLine(`Found component "${componentName}" with type "${matchedComponent.Type}"`);
                
                if (!validTypes.includes(matchedComponent.Type)) {
                    outputChannel.appendLine(`Component type "${matchedComponent.Type}" is not valid. Valid types: ${validTypes.join(', ')}`);
                    results[componentName] = {
                        valid: false,
                        error: `Component "${componentName}" is not a valid script component type. Must be one of: ${validTypes.join(', ')}`,
                        type: matchedComponent.Type
                    };
                    continue;
                }
                
                // Component is valid
                results[componentName] = {
                    valid: true,
                    type: matchedComponent.Type
                };
                outputChannel.appendLine(`Component "${componentName}" validation successful`);
            }
            
            return results;
        } catch (err) {
            outputChannel.appendLine(`Error validating components: ${err}`);
            // Return error for all components
            for (const componentName of componentNames) {
                results[componentName] = {
                    valid: false,
                    error: `Error validating component: ${err}`
                };
            }
            return results;
        }
    }

    // Legacy function for backward compatibility (now uses the optimized version)
    async function validateComponent(client: QrcClient, componentName: string): Promise<boolean> {
        const results = await validateComponents(client, [componentName]);
        const result = results[componentName];
        
        if (!result.valid && result.error) {
            vscode.window.showErrorMessage(result.error);
        }
        
        return result.valid;
    }
    
    // Deploy script to Q-SYS Core
    async function deployScript(filePath: string, core: QSysCore, componentName: string): Promise<boolean> {
        outputChannel.appendLine(`\n--- Starting deployment to ${core.name} (${core.ip}) ---`);
        outputChannel.appendLine(`Component: ${componentName}`);
        outputChannel.appendLine(`File: ${filePath}`);
        
        const client = new QrcClient(core.ip, 1710, outputChannel);
        
        try {
            // Connect to the core
            outputChannel.appendLine('Connecting to core...');
            await client.connect();
            
            // Authenticate if credentials are provided
            if (core.username && core.password) {
                outputChannel.appendLine('Authenticating...');
                await client.login(core.username, core.password);
                outputChannel.appendLine('Authentication successful');
            }
            
            // Validate component
            outputChannel.appendLine(`Validating component "${componentName}"...`);
            const isValid = await validateComponent(client, componentName);
            if (!isValid) {
                outputChannel.appendLine('Component validation failed');
                client.disconnect();
                return false;
            }
            outputChannel.appendLine('Component validation successful');
            
            // Get script content
            outputChannel.appendLine('Reading script content...');
            const document = await vscode.workspace.openTextDocument(filePath);
            const scriptContent = document.getText();
            outputChannel.appendLine(`Script content length: ${scriptContent.length} characters`);
            
            // Deploy script
            outputChannel.appendLine('Deploying script...');
            await client.setScript(componentName, scriptContent);
            
            outputChannel.appendLine('Deployment successful');
            vscode.window.showInformationMessage(`Script deployed to ${componentName} on ${core.name}`);
            updateStatusBar(true, core.name);
            
            // Disconnect
            client.disconnect();
            outputChannel.appendLine('Disconnected from core');
            return true;
        } catch (err) {
            outputChannel.appendLine(`Deployment failed: ${err}`);
            vscode.window.showErrorMessage(`Deployment failed: ${err}`);
            updateStatusBar(false);
            client.disconnect();
            outputChannel.appendLine('Disconnected from core');
            return false;
        }
    }

    // Optimized deployment function with connection pooling and cancellation support
    async function deployScriptOptimized(
        filePath: string,
        targets: Array<{core: QSysCore, componentNames: string[]}>,
        connectionPool: ConnectionPoolManager,
        cancellationToken?: DeploymentCancellationToken,
        progress?: vscode.Progress<{message?: string, increment?: number}>
    ): Promise<DeploymentResult[]> {
        const results: DeploymentResult[] = [];
        const settings = getSettings();
        
        // Check for cancellation at start
        try {
            cancellationToken?.throwIfCancelled();
        } catch (error) {
            // Return cancelled results for all targets
            for (const target of targets) {
                for (const componentName of target.componentNames) {
                    results.push({
                        success: false,
                        core: target.core,
                        componentName,
                        cancelled: true,
                        error: 'Deployment cancelled by user'
                    });
                }
            }
            return results;
        }
        
        // Group targets by core to optimize connection reuse
        const coreGroups = new Map<string, {core: QSysCore, components: string[]}>();
        
        for (const target of targets) {
            const coreKey = `${target.core.ip}:${target.core.name}`;
            if (!coreGroups.has(coreKey)) {
                coreGroups.set(coreKey, {
                    core: target.core,
                    components: []
                });
            }
            coreGroups.get(coreKey)!.components.push(...target.componentNames);
        }

        const totalComponents = Array.from(coreGroups.values()).reduce((sum, group) => sum + group.components.length, 0);
        outputChannel.appendLine(`\n--- Deployment Starting ---`);
        outputChannel.appendLine(`File: ${filePath}`);
        outputChannel.appendLine(`Cores to deploy to: ${coreGroups.size}`);
        outputChannel.appendLine(`Total components: ${totalComponents}`);

        progress?.report({ increment: 10, message: "Reading script content..." });

        // Read script content once
        let scriptContent: string;
        try {
            cancellationToken?.throwIfCancelled();
            const document = await vscode.workspace.openTextDocument(filePath);
            scriptContent = document.getText();
            outputChannel.appendLine(`Script content length: ${scriptContent.length} characters`);
        } catch (err) {
            if (cancellationToken?.isCancelled) {
                // Return cancelled results for all targets
                for (const target of targets) {
                    for (const componentName of target.componentNames) {
                        results.push({
                            success: false,
                            core: target.core,
                            componentName,
                            cancelled: true,
                            error: 'Deployment cancelled by user'
                        });
                    }
                }
                return results;
            }
            
            outputChannel.appendLine(`Error reading script file: ${err}`);
            // Return failure results for all targets
            for (const target of targets) {
                for (const componentName of target.componentNames) {
                    results.push({
                        success: false,
                        core: target.core,
                        componentName,
                        error: `Failed to read script file: ${err}`
                    });
                }
            }
            return results;
        }

        // Deploy to each core group
        let completedComponents = 0;
        const coreArray = Array.from(coreGroups.entries());
        
        for (let coreIndex = 0; coreIndex < coreArray.length; coreIndex++) {
            const [coreKey, group] = coreArray[coreIndex];
            const { core, components } = group;
            let client: QrcClient | null = null;
            let coreSkipped = false;
            let skipReason = '';

            // Check for cancellation before each core
            try {
                cancellationToken?.throwIfCancelled();
            } catch (error) {
                // Mark remaining components as cancelled
                for (const componentName of components) {
                    results.push({
                        success: false,
                        core,
                        componentName,
                        cancelled: true,
                        error: 'Deployment cancelled by user'
                    });
                }
                continue;
            }

            try {
                outputChannel.appendLine(`\n--- Connecting to ${core.name} (${core.ip}) ---`);
                progress?.report({
                    increment: 0,
                    message: `Connecting to ${core.name}...`
                });
                
                // Get connection from pool (with timeout and cancellation handling)
                client = await connectionPool.getConnection(core, cancellationToken);
                
                outputChannel.appendLine(`Connected successfully to ${core.name}`);
                progress?.report({
                    increment: 0,
                    message: `Validating components on ${core.name}...`
                });

                // Validate all components for this core at once (optimization)
                outputChannel.appendLine(`Validating all ${components.length} components for ${core.name}...`);
                const validationResults = await validateComponents(client, components);
                
                // Deploy to all components on this core
                for (let compIndex = 0; compIndex < components.length; compIndex++) {
                    const componentName = components[compIndex];
                    
                    // Check for cancellation before each component
                    try {
                        cancellationToken?.throwIfCancelled();
                    } catch (error) {
                        results.push({
                            success: false,
                            core,
                            componentName,
                            cancelled: true,
                            error: 'Deployment cancelled by user'
                        });
                        continue;
                    }
                    
                    if (coreSkipped) {
                        // Skip remaining components for this core
                        results.push({
                            success: false,
                            core,
                            componentName,
                            skipped: true,
                            skipReason
                        });
                        continue;
                    }

                    try {
                        outputChannel.appendLine(`Deploying to component: ${componentName}`);
                        progress?.report({
                            increment: 0,
                            message: `Deploying to ${componentName} on ${core.name}...`
                        });
                        
                        // Check validation result (already validated in batch)
                        const validationResult = validationResults[componentName];
                        if (!validationResult.valid) {
                            results.push({
                                success: false,
                                core,
                                componentName,
                                error: validationResult.error || 'Component validation failed'
                            });
                            completedComponents++;
                            const progressPercent = Math.round((completedComponents / totalComponents) * 80) + 20; // 20-100%
                            progress?.report({
                                increment: 0,
                                message: `Component validation failed: ${componentName}`
                            });
                            continue;
                        }

                        // Deploy script
                        await client.setScript(componentName, scriptContent);
                        
                        outputChannel.appendLine(`Successfully deployed to ${componentName} on ${core.name}`);
                        results.push({
                            success: true,
                            core,
                            componentName
                        });

                        completedComponents++;
                        const progressPercent = Math.round((completedComponents / totalComponents) * 80) + 20; // 20-100%
                        progress?.report({
                            increment: 0,
                            message: `Deployed ${completedComponents}/${totalComponents} components`
                        });

                    } catch (err) {
                        if (cancellationToken?.isCancelled) {
                            results.push({
                                success: false,
                                core,
                                componentName,
                                cancelled: true,
                                error: 'Deployment cancelled by user'
                            });
                        } else {
                            outputChannel.appendLine(`Failed to deploy to ${componentName} on ${core.name}: ${err}`);
                            results.push({
                                success: false,
                                core,
                                componentName,
                                error: `${err}`
                            });
                        }
                        
                        completedComponents++;
                        const progressPercent = Math.round((completedComponents / totalComponents) * 80) + 20; // 20-100%
                        progress?.report({
                            increment: 0,
                            message: `Failed: ${componentName} (${completedComponents}/${totalComponents})`
                        });
                    }
                }

            } catch (err) {
                // Check if this is a cancellation error
                const isCancelled = cancellationToken?.isCancelled || (err instanceof Error && err.message.includes('cancelled'));
                
                if (isCancelled) {
                    outputChannel.appendLine(`Connection to ${core.name} cancelled by user`);
                    // Mark all components for this core as cancelled
                    for (const componentName of components) {
                        results.push({
                            success: false,
                            core,
                            componentName,
                            cancelled: true,
                            error: 'Deployment cancelled by user'
                        });
                        completedComponents++;
                    }
                } else {
                    outputChannel.appendLine(`Failed to connect to ${core.name}: ${err}`);
                    
                    // Check if this is a timeout error
                    const isTimeout = err instanceof Error && err.message.includes('timeout');
                    if (isTimeout) {
                        coreSkipped = true;
                        skipReason = `Connection timeout after ${settings.connectionTimeout}ms`;
                        outputChannel.appendLine(`Skipping all remaining deployments to ${core.name} due to timeout`);
                    }

                    // Mark all components for this core as failed/skipped
                    for (const componentName of components) {
                        results.push({
                            success: false,
                            core,
                            componentName,
                            error: isTimeout ? undefined : `${err}`,
                            skipped: isTimeout,
                            skipReason: isTimeout ? skipReason : undefined
                        });
                        completedComponents++;
                    }
                }

                // Close the failed connection
                if (client) {
                    connectionPool.closeConnection(core);
                }
            }
        }

        outputChannel.appendLine(`\n--- Deployment Complete ---`);
        return results;
    }

    // Deploy with progress notification and cancellation support
    async function deployWithProgress<T>(
        title: string,
        deploymentFunction: (
            cancellationToken: DeploymentCancellationToken,
            progress: vscode.Progress<{message?: string, increment?: number}>
        ) => Promise<T>
    ): Promise<T> {
        const cancellationToken = new DeploymentCancellationToken();
        
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: title,
            cancellable: true
        }, async (progress, token) => {
            // Handle VSCode's cancellation token
            token.onCancellationRequested(() => {
                outputChannel.appendLine('Deployment cancellation requested by user');
                cancellationToken.cancel();
            });
            
            progress.report({ increment: 0, message: "Initializing deployment..." });
            
            try {
                return await deploymentFunction(cancellationToken, progress);
            } catch (error) {
                if (cancellationToken.isCancelled) {
                    outputChannel.appendLine('Deployment cancelled by user');
                    vscode.window.showInformationMessage('Q-SYS deployment cancelled by user');
                    throw new Error('Deployment cancelled');
                }
                throw error;
            }
        });
    }

    // Helper function to display deployment results
    function displayDeploymentResults(results: DeploymentResult[]): void {
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success && !r.skipped);
        const skipped = results.filter(r => r.skipped);

        outputChannel.appendLine(`\n--- Deployment Summary ---`);
        outputChannel.appendLine(`Successful: ${successful.length}`);
        outputChannel.appendLine(`Failed: ${failed.length}`);
        outputChannel.appendLine(`Skipped: ${skipped.length}`);

        if (successful.length > 0) {
            outputChannel.appendLine(`\nSuccessful deployments:`);
            successful.forEach(r => {
                outputChannel.appendLine(`  ✓ ${r.componentName} on ${r.core.name}`);
            });
        }

        if (failed.length > 0) {
            outputChannel.appendLine(`\nFailed deployments:`);
            failed.forEach(r => {
                outputChannel.appendLine(`  ✗ ${r.componentName} on ${r.core.name}: ${r.error}`);
            });
        }

        if (skipped.length > 0) {
            outputChannel.appendLine(`\nSkipped deployments:`);
            skipped.forEach(r => {
                outputChannel.appendLine(`  ⚠ ${r.componentName} on ${r.core.name}: ${r.skipReason}`);
            });
        }

        // Show user notification
        if (successful.length > 0 && failed.length === 0 && skipped.length === 0) {
            vscode.window.showInformationMessage(`Script deployed successfully to all ${successful.length} targets.`);
        } else if (successful.length > 0 && (failed.length > 0 || skipped.length > 0)) {
            const message = `Script deployed to ${successful.length} targets. ${failed.length} failed, ${skipped.length} skipped.`;
            vscode.window.showWarningMessage(message);
        } else if (successful.length === 0 && (failed.length > 0 || skipped.length > 0)) {
            const message = `Script deployment failed on all targets. ${failed.length} failed, ${skipped.length} skipped due to timeouts.`;
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showInformationMessage('No deployments were attempted.');
        }
    }
    
    // Helper types for selection QuickPicks
    interface CoreQuickPickItem extends vscode.QuickPickItem {
        core: QSysCore;
    }

    interface ComponentQuickPickItem extends vscode.QuickPickItem {
        componentName: string;
    }
    
    // Helper function to show multi-select QuickPick for cores
    async function showCoreSelectionQuickPick(coreItems: CoreQuickPickItem[], canPickMany: boolean = false) {
        if (!canPickMany) {
            // Single selection - don't show Select All option
            return vscode.window.showQuickPick<CoreQuickPickItem>(coreItems, {
                placeHolder: 'Select Q-SYS Core to deploy to'
            });
        }

        // Multi-selection using VSCode's built-in Select All functionality
        const quickPick = vscode.window.createQuickPick<CoreQuickPickItem>();
        quickPick.items = coreItems;
        quickPick.canSelectMany = true;
        quickPick.placeholder = 'Select Q-SYS Cores to deploy to (use the checkbox at the top to select all)';

        return new Promise<CoreQuickPickItem[] | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                const selection = quickPick.selectedItems;
                quickPick.hide();
                resolve(selection.length > 0 ? [...selection] : undefined);
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
                resolve(undefined);
            });

            quickPick.show();
        });
    }

    // Helper function to show multi-select QuickPick for components
    async function showComponentSelectionQuickPick(componentItems: ComponentQuickPickItem[]) {
        const quickPick = vscode.window.createQuickPick<ComponentQuickPickItem>();
        quickPick.items = componentItems;
        quickPick.canSelectMany = true;
        quickPick.placeholder = 'Select components to deploy to (use the checkbox at the top to select all)';

        return new Promise<ComponentQuickPickItem[] | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                const selection = quickPick.selectedItems;
                quickPick.hide();
                resolve(selection.length > 0 ? [...selection] : undefined);
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
                resolve(undefined);
            });

            quickPick.show();
        });
    }
    
    // Command: Deploy current script
    const deployCurrentScriptCommand = vscode.commands.registerCommand('qsys-deploy.deployCurrentScript', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        
        const filePath = editor.document.uri.fsPath;
        const scriptMappings = findScriptMappings(filePath);
        const settings = getSettings();
        
        if (settings.cores.length === 0) {
            vscode.window.showErrorMessage('No cores configured. Please add cores in the settings.json file.');
            return;
        }
        
        // Arrays to hold selected cores and components for deployment
        let selectedCores: QSysCore[] = [];
        let deployTargets: Array<{core: QSysCore, componentNames: string[]}> = [];
        
        if (scriptMappings) {
            // Script mapping exists - present configured cores with multi-select
            const coreItems = scriptMappings.targets.map(target => ({
                label: target.core.name,
                description: target.core.ip,
                core: target.core
            }));
            
            const selectedCoreItems = await showCoreSelectionQuickPick(coreItems, true) as CoreQuickPickItem[] | undefined;
            
            if (!selectedCoreItems || selectedCoreItems.length === 0) {
                return; // User cancelled
            }
            
            // Process selected cores (no custom Select All item to filter out)
            selectedCores = selectedCoreItems.map((item: CoreQuickPickItem) => item.core);
            
            // Filter targets to only include selected cores
            const filteredTargets = scriptMappings.targets.filter(target => 
                selectedCores.some(core => core.name === target.core.name)
            );
            
            // Collect all component names across selected cores
            const allComponentItems: Array<{label: string, componentName: string, coreName: string}> = [];
            filteredTargets.forEach(target => {
                target.componentNames.forEach(componentName => {
                    allComponentItems.push({
                        label: `${componentName} (${target.core.name})`,
                        componentName,
                        coreName: target.core.name
                    });
                });
            });
            
            // Show component selection
            const selectedComponentItems = await showComponentSelectionQuickPick(
                allComponentItems.map(item => ({
                    label: item.label,
                    componentName: item.componentName
                }))
            ) as ComponentQuickPickItem[] | undefined;
            
            if (!selectedComponentItems || selectedComponentItems.length === 0) {
                return; // User cancelled
            }
            
            let selectedComponentNames: string[] = [];
            
            // Process selected components (no custom Select All item to filter out)
            selectedComponentNames = selectedComponentItems.map((item: ComponentQuickPickItem) => item.componentName);
            
            // Build deploy targets
            deployTargets = filteredTargets.map(target => {
                return {
                    core: target.core,
                    componentNames: target.componentNames.filter(componentName => 
                        selectedComponentNames.includes(componentName)
                    )
                };
            }).filter(target => target.componentNames.length > 0);
            
        } else {
            // No mapping found - show all available cores
            const coreItems = settings.cores.map(core => ({
                label: core.name,
                description: core.ip,
                core
            }));
            
            const selectedCoreItem = await showCoreSelectionQuickPick(coreItems, false);
            
            if (!selectedCoreItem) {
                return;
            }
            
            // Handle single selection (not array)
            const selectedCore = Array.isArray(selectedCoreItem) ? selectedCoreItem[0].core : selectedCoreItem.core;
            
            // Ask for component name
            const componentName = await vscode.window.showInputBox({
                prompt: 'Enter component name',
                placeHolder: 'e.g., MainController'
            });
            
            if (!componentName) {
                return;
            }
            
            deployTargets = [{
                core: selectedCore,
                componentNames: [componentName]
            }];
        }
        
        // Deploy to all selected targets using optimized deployment with progress modal
        const results = await deployWithProgress(
            "Q-SYS Script Deployment",
            async (cancellationToken, progress) => {
                return await deployScriptOptimized(filePath, deployTargets, connectionPool, cancellationToken, progress);
            }
        );
        displayDeploymentResults(results);
        
        // Close connections after deployment
        connectionPool.closeAllConnections();
        
        const successCount = results.filter(r => r.success).length;
        
        // Ask if user wants to save this mapping (only for new mappings)
        if (!scriptMappings && successCount > 0) {
            const saveMapping = await vscode.window.showInformationMessage(
                'Script deployed successfully. Would you like to save this mapping?',
                'Save Mapping'
            );
            
            if (saveMapping === 'Save Mapping') {
                // Add mapping to configuration
                const config = vscode.workspace.getConfiguration('qsys-deploy');
                const scripts = config.get<ScriptMapping[]>('scripts', []);
                const normalizedFilePath = vscode.workspace.asRelativePath(filePath);
                
                // Create new script mapping
                scripts.push({
                    filePath: normalizedFilePath,
                    targets: deployTargets.map(target => ({
                        coreNames: [target.core.name],
                        coreName: target.core.name, // Keep for backward compatibility
                        components: target.componentNames
                    }))
                });
                
                await config.update('scripts', scripts, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage('Script mapping saved');
            }
        }
    });
    
    
    // Command: Deploy to All
    const deployToAllCommand = vscode.commands.registerCommand('qsys-deploy.deployToAll', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        
        const filePath = editor.document.uri.fsPath;
        const scriptMappings = findScriptMappings(filePath);
        
        if (!scriptMappings) {
            vscode.window.showErrorMessage('No script mapping found for this file. Please configure script mappings in settings.');
            return;
        }
        
        // Deploy to ALL defined script mappings using optimized deployment with progress modal
        outputChannel.appendLine(`\n--- Deploy to All: Starting deployment for ${filePath} ---`);
        
        const results = await deployWithProgress(
            "Q-SYS Deploy to All",
            async (cancellationToken, progress) => {
                return await deployScriptOptimized(filePath, scriptMappings.targets, connectionPool, cancellationToken, progress);
            }
        );
        displayDeploymentResults(results);
        
        // Close connections after deployment
        connectionPool.closeAllConnections();
        
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success && !r.skipped).length;
        const skippedCount = results.filter(r => r.skipped).length;
        
        outputChannel.appendLine(`--- Deploy to All: Completed (${successCount} success, ${failCount} failed, ${skippedCount} skipped) ---`);
    });
    
    // Command: Quick Deploy
    const quickDeployCommand = vscode.commands.registerCommand('qsys-deploy.quickDeploy', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        
        const filePath = editor.document.uri.fsPath;
        const scriptMappings = findScriptMappings(filePath);
        
        if (!scriptMappings) {
            vscode.window.showErrorMessage('No script mapping found for this file. Please configure script mappings in settings.');
            return;
        }
        
        // Find targets with quickDeploy: true
        const quickDeployTargets: Array<{core: QSysCore, componentNames: string[]}> = [];
        const settings = getSettings();
        
        // Use the original script mapping targets, not the processed ones
        for (const target of scriptMappings.script.targets) {
            if (target.quickDeploy === true) {
                // Handle both new coreNames array and legacy coreName
                const coreNamesToProcess = target.coreNames || (target.coreName ? [target.coreName] : []);
                
                for (const coreName of coreNamesToProcess) {
                    const core = settings.cores.find(c => c.name === coreName);
                    if (core) {
                        quickDeployTargets.push({
                            core,
                            componentNames: target.components
                        });
                    }
                }
            }
        }
        
        if (quickDeployTargets.length === 0) {
            vscode.window.showInformationMessage('No quick deploy targets found. Set "quickDeploy: true" in your script mappings to enable quick deploy.');
            return;
        }
        
        // Deploy to quick deploy targets using optimized deployment with progress modal
        outputChannel.appendLine(`\n--- Quick Deploy: Starting deployment for ${filePath} ---`);
        outputChannel.appendLine(`Found ${quickDeployTargets.length} quick deploy targets`);
        
        const results = await deployWithProgress(
            "Q-SYS Quick Deploy",
            async (cancellationToken, progress) => {
                return await deployScriptOptimized(filePath, quickDeployTargets, connectionPool, cancellationToken, progress);
            }
        );
        displayDeploymentResults(results);
        
        // Close connections after deployment
        connectionPool.closeAllConnections();
        
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success && !r.skipped).length;
        const skippedCount = results.filter(r => r.skipped).length;
        
        outputChannel.appendLine(`--- Quick Deploy: Completed (${successCount} success, ${failCount} failed, ${skippedCount} skipped) ---`);
    });
    
    // Command: Test connection
    const testConnectionCommand = vscode.commands.registerCommand('qsys-deploy.testConnection', async () => {
        const settings = getSettings();
        
        if (settings.cores.length === 0) {
            vscode.window.showErrorMessage('No cores configured. Please add cores in the settings.json file.');
            return;
        }
        
        const coreItems = settings.cores.map(core => ({
            label: core.name,
            description: core.ip,
            core
        }));
        
        const selectedCore = await vscode.window.showQuickPick(coreItems, {
            placeHolder: 'Select a Q-SYS Core to test'
        });
        
        if (!selectedCore) {
            return;
        }
        
        outputChannel.clear();
        outputChannel.show();
        outputChannel.appendLine(`\n--- Testing connection to ${selectedCore.core.name} (${selectedCore.core.ip}) ---`);
        
        const client = new QrcClient(selectedCore.core.ip, 1710, outputChannel, settings.connectionTimeout);
        
        try {
            // Connect to the core
            outputChannel.appendLine('Connecting to core...');
            await client.connect();
            
            // Authenticate if credentials are provided
            if (selectedCore.core.username && selectedCore.core.password) {
                outputChannel.appendLine('Authenticating...');
                await client.login(selectedCore.core.username, selectedCore.core.password);
                outputChannel.appendLine('Authentication successful');
            }
            
            // Get components to verify connection
            outputChannel.appendLine('Getting components...');
            const components = await client.getComponents();
            
            outputChannel.appendLine(`Found ${components.length} components:`);
            components.forEach(comp => {
                outputChannel.appendLine(`- ${comp.Name} (Type: ${comp.Type})`);
            });
            
            vscode.window.showInformationMessage(`Successfully connected to ${selectedCore.core.name}. Found ${components.length} components.`);
            updateStatusBar(true, selectedCore.core.name);
            
            // Disconnect
            client.disconnect();
            outputChannel.appendLine('Disconnected from core');
        } catch (err) {
            outputChannel.appendLine(`Connection failed: ${err}`);
            vscode.window.showErrorMessage(`Connection failed: ${err}`);
            updateStatusBar(false);
            client.disconnect();
            outputChannel.appendLine('Disconnected from core');
        }
    });
    
    
    // File save event handler for auto-deploy
    const onSaveHandler = vscode.workspace.onDidSaveTextDocument(async (document) => {
        // Only process Lua files
        if (document.languageId !== 'lua') {
            return;
        }
        
        const settings = getSettings();
        const filePath = document.uri.fsPath;
        const scriptMappings = findScriptMappings(filePath);
        
        if (scriptMappings) {
            // Check if auto-deploy is enabled
            const autoDeployForScript = scriptMappings.script.autoDeployOnSave !== undefined
                ? scriptMappings.script.autoDeployOnSave
                : settings.autoDeployOnSave;
            
            if (autoDeployForScript) {
                // Deploy to all targets using optimized deployment (no progress modal for auto-deploy)
                outputChannel.appendLine(`\n--- Auto-Deploy: Starting deployment for ${filePath} ---`);
                const cancellationToken = new DeploymentCancellationToken(); // Create token but no UI
                const results = await deployScriptOptimized(filePath, scriptMappings.targets, connectionPool, cancellationToken);
                
                // Log results but don't show UI notifications for auto-deploy
                const successCount = results.filter(r => r.success).length;
                const failCount = results.filter(r => !r.success && !r.skipped).length;
                const skippedCount = results.filter(r => r.skipped).length;
                
                outputChannel.appendLine(`--- Auto-Deploy: Completed (${successCount} success, ${failCount} failed, ${skippedCount} skipped) ---`);
                
                // Close connections after auto-deploy
                connectionPool.closeAllConnections();
            }
        }
    });
    
    // Register all commands and event handlers
    context.subscriptions.push(
        deployCurrentScriptCommand,
        deployToAllCommand,
        quickDeployCommand,
        testConnectionCommand,
        showDebugOutputCommand,
        onSaveHandler
    );
}

// Extension deactivation
export function deactivate() {
    console.log('Q-SYS Deploy extension is now deactivated');
}
