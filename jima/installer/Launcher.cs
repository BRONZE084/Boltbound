using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace ZaoluRaceLauncher
{
    internal static class Program
    {
        private const string MutexName = @"Local\ZaoluRaceLauncher_32145";
        private const string OpenRequestEventName = @"Local\ZaoluRaceLauncher_OpenGame_32145";
        internal const int GamePort = 32145;
        internal static readonly string LocalGameUrl = "http://127.0.0.1:" + GamePort + "/";

        [STAThread]
        private static void Main()
        {
            try
            {
                // TLS 1.2 is not named by the oldest .NET 4 reference assemblies.
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
            }
            catch
            {
                // The local server still works if an older runtime cannot set TLS 1.2.
            }

            bool createdNew;
            Mutex instanceMutex = null;
            EventWaitHandle openRequestEvent = null;
            bool ownsMutex = false;

            try
            {
                instanceMutex = new Mutex(true, MutexName, out createdNew);
                ownsMutex = createdNew;

                if (!createdNew)
                {
                    SignalOpenRequest();
                    return;
                }

                openRequestEvent = new EventWaitHandle(false, EventResetMode.AutoReset, OpenRequestEventName);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (LauncherForm launcher = new LauncherForm(openRequestEvent))
                {
                    Application.Run(launcher);
                }
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    "启动器无法继续运行。\r\n\r\n" + exception.Message,
                    "造路狂奔",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            finally
            {
                if (openRequestEvent != null)
                {
                    openRequestEvent.Dispose();
                }

                if (ownsMutex && instanceMutex != null)
                {
                    try { instanceMutex.ReleaseMutex(); }
                    catch (ApplicationException) { }
                }

                if (instanceMutex != null)
                {
                    instanceMutex.Dispose();
                }
            }
        }

        private static void SignalOpenRequest()
        {
            for (int attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    using (EventWaitHandle requestEvent = EventWaitHandle.OpenExisting(OpenRequestEventName))
                    {
                        requestEvent.Set();
                        return;
                    }
                }
                catch (WaitHandleCannotBeOpenedException)
                {
                    Thread.Sleep(100);
                }
                catch
                {
                    return;
                }
            }
        }

        internal static bool OpenUrl(string url, bool showError)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = url;
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
                return true;
            }
            catch (Exception exception)
            {
                if (showError)
                {
                    MessageBox.Show(
                        "无法打开浏览器。\r\n\r\n" + exception.Message,
                        "造路狂奔",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }

                return false;
            }
        }
    }

    internal enum PublicHealthResult
    {
        Ready,
        DnsFailure,
        HttpFailure,
        Timeout,
        TransportFailure
    }

    internal static class TunnelHealthPolicy
    {
        private static readonly Regex TunnelRegisteredPattern = new Regex(
            @"(?:^|[^A-Za-z])Registered tunnel connection(?:[^A-Za-z]|$)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        internal const int RegistrationTimeoutSeconds = 90;
        internal const int PublicHealthInitialDelaySeconds = 75;
        internal const int DnsPropagationGraceSeconds = 180;

        internal static bool CanCheckPublicHealth(bool hasUrl, bool registered)
        {
            return hasUrl && registered;
        }

        internal static bool ShouldProbePublicHealth(
            bool hasUrl,
            bool registered,
            TimeSpan registeredLifetime)
        {
            return CanCheckPublicHealth(hasUrl, registered) &&
                registeredLifetime.TotalSeconds >= PublicHealthInitialDelaySeconds;
        }

        internal static bool ContainsTunnelRegistration(string text)
        {
            return !String.IsNullOrEmpty(text) && TunnelRegisteredPattern.IsMatch(text);
        }

        internal static bool IsRegistrationTimedOut(
            bool hasUrl,
            bool registered,
            TimeSpan tunnelLifetime)
        {
            return !CanCheckPublicHealth(hasUrl, registered) &&
                tunnelLifetime.TotalSeconds >= RegistrationTimeoutSeconds;
        }

        internal static PublicHealthResult ClassifyWebException(WebExceptionStatus status)
        {
            if (status == WebExceptionStatus.NameResolutionFailure ||
                status == WebExceptionStatus.ProxyNameResolutionFailure)
            {
                return PublicHealthResult.DnsFailure;
            }

            if (status == WebExceptionStatus.ProtocolError)
            {
                return PublicHealthResult.HttpFailure;
            }

            if (status == WebExceptionStatus.Timeout ||
                status == WebExceptionStatus.RequestCanceled)
            {
                return PublicHealthResult.Timeout;
            }

            return PublicHealthResult.TransportFailure;
        }

        internal static bool ShouldRestartForPublicFailure(
            PublicHealthResult result,
            int consecutiveFailures,
            TimeSpan tunnelLifetime,
            TimeSpan registeredLifetime)
        {
            // Local probing is advisory: it cannot prove the URL is unusable remotely.
            return false;
        }

        internal static string GetFailureStatus(
            PublicHealthResult result,
            bool hasPublishedUrl,
            bool withinDnsGrace)
        {
            string retained = hasPublishedUrl
                ? "，已保留现有联机链接。"
                : "，将继续使用当前隧道。";

            switch (result)
            {
                case PublicHealthResult.DnsFailure:
                    return withinDnsGrace
                        ? "公网地址已注册，DNS 正在生效" + retained
                        : "当前网络暂时无法解析公网地址" + retained;
                case PublicHealthResult.HttpFailure:
                    return "公网服务响应暂时异常" + retained;
                case PublicHealthResult.Timeout:
                    return "公网连接响应较慢" + retained;
                default:
                    return "公网网络暂时波动" + retained;
            }
        }
    }

    internal sealed class LauncherForm : Form
    {
        private static readonly Regex TunnelUrlPattern = new Regex(
            @"https://[a-z0-9-]+\.trycloudflare\.com\b",
            RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly int[] TunnelRetrySeconds = { 2, 5, 10, 20, 30 };

        private readonly string installRoot;
        private readonly string appRoot;
        private readonly string nodePath;
        private readonly string cloudflaredPath;
        private readonly string serverEntryPath;
        private readonly string currentUrlPath;
        private readonly string childPidPath;
        private readonly string tunnelLogPath;
        private readonly object processLock = new object();
        private readonly object stateLock = new object();
        private readonly ManualResetEvent stopEvent = new ManualResetEvent(false);
        private readonly EventWaitHandle openRequestEvent;

        private Label statusLabel;
        private TextBox publicUrlTextBox;
        private Button copyButton;
        private Button openButton;
        private Button reconnectButton;
        private Button exitButton;

        private Thread supervisorThread;
        private Process nodeProcess;
        private Process tunnelProcess;
        private IntPtr childJobHandle = IntPtr.Zero;
        private string tunnelCandidateUrl;
        private string currentPublicUrl;
        private string lastQueuedStatus;
        private DateTime tunnelStartedUtc;
        private DateTime tunnelRegisteredUtc;
        private DateTime nextTunnelStartUtc = DateTime.MinValue;
        private DateTime nextNodeStartUtc = DateTime.MinValue;
        private DateTime nextPublicHealthCheckUtc = DateTime.MinValue;
        private int tunnelFailureCount;
        private int localHealthFailures;
        private int tunnelGeneration;
        private int openBrowserRequested = 1;
        private int reconnectRequested;
        private int shutdownStarted;
        private bool tunnelRegistered;
        private volatile bool closing;

        internal LauncherForm(EventWaitHandle requestEvent)
        {
            openRequestEvent = requestEvent;
            installRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            appRoot = Path.Combine(installRoot, "app");
            nodePath = Path.Combine(installRoot, "runtime", "node.exe");
            cloudflaredPath = Path.Combine(installRoot, "runtime", "cloudflared.exe");
            serverEntryPath = Path.Combine(appRoot, "server", "index.js");
            currentUrlPath = Path.Combine(installRoot, "current-url.txt");
            childPidPath = Path.Combine(installRoot, "runtime", "launcher-children.txt");
            tunnelLogPath = Path.Combine(installRoot, "runtime", "tunnel.log");
            DeleteCurrentUrlFile();
            CleanupRecordedChildren();
            InitializeChildJob();

            InitializeWindow();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            supervisorThread = new Thread(SupervisorLoop);
            supervisorThread.Name = "ZaoluRaceSupervisor";
            supervisorThread.IsBackground = true;
            supervisorThread.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            Shutdown(true);

            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Shutdown(false);
                // If a network request is still timing out, its background thread may
                // still observe this handle. The OS reclaims it when the process exits.
                if (supervisorThread == null || !supervisorThread.IsAlive)
                {
                    stopEvent.Dispose();
                }
            }

            base.Dispose(disposing);
        }

        private void Shutdown(bool updateControls)
        {
            if (Interlocked.Exchange(ref shutdownStarted, 1) != 0)
            {
                return;
            }

            closing = true;
            stopEvent.Set();
            if (updateControls && IsHandleCreated && !IsDisposed && !Disposing)
            {
                SetControlsForShutdown();
            }

            if (supervisorThread != null && supervisorThread.IsAlive &&
                Thread.CurrentThread != supervisorThread)
            {
                supervisorThread.Join(6000);
            }

            StopOwnedChildren();
            CloseChildJob();
            DeleteFileIfPresent(childPidPath);
            SetPublicUrl(null);
        }

        private void InitializeWindow()
        {
            Text = "造路狂奔 - 联机启动器";
            ClientSize = new Size(600, 245);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.FromArgb(244, 247, 246);
            AutoScaleMode = AutoScaleMode.Dpi;

            Label titleLabel = new Label();
            titleLabel.AutoSize = true;
            titleLabel.Font = new Font(Font.FontFamily, 15F, FontStyle.Bold);
            titleLabel.ForeColor = Color.FromArgb(31, 55, 53);
            titleLabel.Location = new Point(24, 20);
            titleLabel.Text = "造路狂奔";
            Controls.Add(titleLabel);

            statusLabel = new Label();
            statusLabel.AutoEllipsis = true;
            statusLabel.Location = new Point(26, 60);
            statusLabel.Size = new Size(548, 24);
            statusLabel.ForeColor = Color.FromArgb(78, 91, 90);
            statusLabel.Text = "正在启动本地游戏服务...";
            Controls.Add(statusLabel);

            Label linkLabel = new Label();
            linkLabel.AutoSize = true;
            linkLabel.Location = new Point(26, 94);
            linkLabel.Text = "异地联机地址";
            Controls.Add(linkLabel);

            publicUrlTextBox = new TextBox();
            publicUrlTextBox.Location = new Point(26, 117);
            publicUrlTextBox.Size = new Size(548, 25);
            publicUrlTextBox.ReadOnly = true;
            publicUrlTextBox.TabStop = false;
            publicUrlTextBox.BackColor = Color.White;
            publicUrlTextBox.Text = "正在建立安全连接...";
            Controls.Add(publicUrlTextBox);

            copyButton = CreateButton("复制链接", 26, 167, 118);
            copyButton.Enabled = false;
            copyButton.Click += CopyButtonClick;

            openButton = CreateButton("打开游戏", 158, 167, 118);
            openButton.Click += delegate { Program.OpenUrl(Program.LocalGameUrl, true); };

            reconnectButton = CreateButton("重新连接", 290, 167, 118);
            reconnectButton.Click += ReconnectButtonClick;

            exitButton = CreateButton("退出", 456, 167, 118);
            exitButton.Click += delegate { Close(); };

            AcceptButton = openButton;
            CancelButton = exitButton;
        }

        private Button CreateButton(string text, int x, int y, int width)
        {
            Button button = new Button();
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, 34);
            button.UseVisualStyleBackColor = true;
            Controls.Add(button);
            return button;
        }

        private void CopyButtonClick(object sender, EventArgs e)
        {
            string url = GetCurrentPublicUrl();
            if (String.IsNullOrEmpty(url))
            {
                MessageBox.Show(
                    "公网连接还没有准备好，请稍候。",
                    "造路狂奔",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            Exception clipboardError = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    Clipboard.SetText(url, TextDataFormat.Text);
                    statusLabel.Text = "链接已复制，可以发给异地玩家。";
                    return;
                }
                catch (Exception exception)
                {
                    clipboardError = exception;
                    Thread.Sleep(80);
                }
            }

            MessageBox.Show(
                "无法复制链接。\r\n\r\n" + (clipboardError == null ? "剪贴板不可用。" : clipboardError.Message),
                "造路狂奔",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }

        private void ReconnectButtonClick(object sender, EventArgs e)
        {
            if (closing)
            {
                return;
            }

            reconnectButton.Enabled = false;
            SetPublicUrl(null);
            SetStatus("正在重新建立异地联机连接...");
            Interlocked.Exchange(ref reconnectRequested, 1);
        }

        private void SupervisorLoop()
        {
            try
            {
                while (!closing && !stopEvent.WaitOne(0))
                {
                    try
                    {
                        SupervisorIteration();
                    }
                    catch (Exception exception)
                    {
                        SetStatus("后台监控遇到问题，将自动重试：" + ShortMessage(exception));
                    }

                    if (stopEvent.WaitOne(1000))
                    {
                        break;
                    }
                }
            }
            finally
            {
                StopOwnedChildren();
            }
        }

        private void SupervisorIteration()
        {
            DateTime now = DateTime.UtcNow;
            if (openRequestEvent.WaitOne(0))
            {
                Interlocked.Exchange(ref openBrowserRequested, 1);
            }

            if (Interlocked.Exchange(ref reconnectRequested, 0) == 1)
            {
                StopTunnel();
                ClearTunnelState(true);
                tunnelFailureCount = 0;
                nextTunnelStartUtc = DateTime.MinValue;
            }

            bool localHealthy = CheckHealthEndpoint(Program.LocalGameUrl, 1800) == PublicHealthResult.Ready;
            now = DateTime.UtcNow;
            if (localHealthy)
            {
                localHealthFailures = 0;
                if (Interlocked.Exchange(ref openBrowserRequested, 0) == 1)
                {
                    PostUi(delegate { Program.OpenUrl(Program.LocalGameUrl, true); });
                }
            }
            else
            {
                localHealthFailures++;
                SetStatus("正在启动本地游戏服务...");

                if (IsNodeRunning() && localHealthFailures >= 5)
                {
                    StopNode();
                    nextNodeStartUtc = now.AddSeconds(2);
                    localHealthFailures = 0;
                }

                if (!IsNodeRunning() && GetNodeProcessReference() != null)
                {
                    StopNode();
                }

                if (!IsNodeRunning() && now >= nextNodeStartUtc)
                {
                    if (StartNode())
                    {
                        nextNodeStartUtc = now.AddSeconds(5);
                    }
                    else
                    {
                        nextNodeStartUtc = now.AddSeconds(10);
                    }
                }
            }

            if (!IsTunnelRunning())
            {
                bool hadTunnel = GetTunnelProcessReference() != null;
                if (hadTunnel)
                {
                    StopTunnel();
                    ClearTunnelState(true);
                    ScheduleTunnelRetry(DateTime.UtcNow);
                }

                if (localHealthy && now >= nextTunnelStartUtc)
                {
                    ClearTunnelState(false);
                    if (StartTunnel())
                    {
                        tunnelStartedUtc = DateTime.UtcNow;
                        SetStatus("本地游戏已启动，正在建立异地联机连接...");
                    }
                    else
                    {
                        ScheduleTunnelRetry(DateTime.UtcNow);
                    }
                }

                return;
            }

            int generation = Volatile.Read(ref tunnelGeneration);
            string candidateUrl;
            bool registered;
            DateTime registeredUtc;
            GetTunnelState(out candidateUrl, out registered, out registeredUtc);
            if (!TunnelHealthPolicy.CanCheckPublicHealth(
                !String.IsNullOrEmpty(candidateUrl), registered))
            {
                CaptureTunnelOutputFromLog(generation);
                GetTunnelState(out candidateUrl, out registered, out registeredUtc);
            }

            now = DateTime.UtcNow;
            bool hasCandidateUrl = !String.IsNullOrEmpty(candidateUrl);
            if (!TunnelHealthPolicy.CanCheckPublicHealth(hasCandidateUrl, registered))
            {
                if (TunnelHealthPolicy.IsRegistrationTimedOut(
                    hasCandidateUrl, registered, now - tunnelStartedUtc))
                {
                    SetStatus("公网地址或隧道注册超时，正在自动更换连接...");
                    RestartTunnelWithBackoff(now);
                }
                else if (localHealthy)
                {
                    if (hasCandidateUrl)
                    {
                        SetStatus("公网地址已生成，正在等待隧道注册完成...");
                    }
                    else if (registered)
                    {
                        SetStatus("隧道已注册，正在获取公网地址...");
                    }
                    else
                    {
                        SetStatus("本地游戏已启动，正在获取异地联机地址...");
                    }
                }

                return;
            }

            if (!String.Equals(GetCurrentPublicUrl(), candidateUrl, StringComparison.OrdinalIgnoreCase))
            {
                SetPublicUrl(candidateUrl);
            }

            tunnelFailureCount = 0;
            nextTunnelStartUtc = DateTime.MinValue;
            SetReconnectEnabled(true);

            TimeSpan registeredLifetime = now - registeredUtc;
            if (!TunnelHealthPolicy.ShouldProbePublicHealth(
                hasCandidateUrl, registered, registeredLifetime))
            {
                SetStatus("异地联机地址已生成，正在等待公网域名生效...");
                return;
            }

            if (now < nextPublicHealthCheckUtc)
            {
                return;
            }

            PublicHealthResult publicHealth = CheckHealthEndpoint(candidateUrl + "/", 4500);
            nextPublicHealthCheckUtc = DateTime.UtcNow.AddSeconds(5);
            if (publicHealth == PublicHealthResult.Ready)
            {
                SetStatus("异地联机已就绪。复制链接发给朋友即可。");
                return;
            }

            bool withinDnsGrace = registeredLifetime.TotalSeconds <
                TunnelHealthPolicy.DnsPropagationGraceSeconds;
            SetStatus(TunnelHealthPolicy.GetFailureStatus(
                publicHealth,
                !String.IsNullOrEmpty(GetCurrentPublicUrl()),
                withinDnsGrace));
        }

        private bool StartNode()
        {
            if (closing)
            {
                return false;
            }

            if (!File.Exists(nodePath))
            {
                SetStatus("安装文件不完整：缺少 runtime\\node.exe");
                return false;
            }

            if (!File.Exists(serverEntryPath))
            {
                SetStatus("安装文件不完整：缺少 app\\server\\index.js");
                return false;
            }

            Process process = null;
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = nodePath;
                startInfo.Arguments = QuoteArgument(serverEntryPath);
                startInfo.WorkingDirectory = appRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.EnvironmentVariables["PORT"] = Program.GamePort.ToString();
                startInfo.EnvironmentVariables["HOST"] = "127.0.0.1";

                process = new Process();
                process.StartInfo = startInfo;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += DrainProcessOutput;
                process.ErrorDataReceived += DrainProcessOutput;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                AttachToChildJob(process);

                bool accepted;
                lock (processLock)
                {
                    accepted = !closing;
                    if (accepted)
                    {
                        nodeProcess = process;
                        PersistChildPidsLocked();
                    }
                }

                if (!accepted)
                {
                    TerminateProcess(process);
                    return false;
                }

                return true;
            }
            catch (Exception exception)
            {
                if (process != null)
                {
                    TerminateProcess(process);
                }

                SetStatus("无法启动本地游戏服务：" + ShortMessage(exception));
                return false;
            }
        }

        private bool StartTunnel()
        {
            if (closing)
            {
                return false;
            }

            if (!File.Exists(cloudflaredPath))
            {
                SetStatus("安装文件不完整：缺少 runtime\\cloudflared.exe");
                return false;
            }

            Process process = null;
            int generation = Interlocked.Increment(ref tunnelGeneration);

            try
            {
                DeleteFileIfPresent(tunnelLogPath);
                using (FileStream tunnelLog = new FileStream(
                    tunnelLogPath,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    tunnelLog.Flush();
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = cloudflaredPath;
                startInfo.Arguments = "tunnel --logfile " + QuoteArgument(tunnelLogPath) +
                    " --no-prechecks --no-autoupdate --url " + Program.LocalGameUrl.TrimEnd('/');
                startInfo.WorkingDirectory = installRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;

                process = new Process();
                process.StartInfo = startInfo;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    CaptureTunnelOutput(args.Data, generation);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    CaptureTunnelOutput(args.Data, generation);
                };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                AttachToChildJob(process);

                bool accepted;
                lock (processLock)
                {
                    accepted = !closing;
                    if (accepted)
                    {
                        tunnelProcess = process;
                        PersistChildPidsLocked();
                    }
                }

                if (!accepted)
                {
                    TerminateProcess(process);
                    return false;
                }

                return true;
            }
            catch (Exception exception)
            {
                if (process != null)
                {
                    TerminateProcess(process);
                }

                SetStatus("无法启动异地联机隧道：" + ShortMessage(exception));
                return false;
            }
        }

        private void CaptureTunnelOutput(string line, int generation)
        {
            if (closing || generation != Volatile.Read(ref tunnelGeneration) || String.IsNullOrEmpty(line))
            {
                return;
            }

            CaptureTunnelDiscovery(line, generation);
        }

        private void CaptureTunnelDiscovery(string text, int generation)
        {
            MatchCollection matches = TunnelUrlPattern.Matches(text);
            bool sawRegistration = TunnelHealthPolicy.ContainsTunnelRegistration(text);
            if (matches.Count == 0 && !sawRegistration)
            {
                return;
            }

            bool published = false;
            lock (stateLock)
            {
                if (closing || generation != tunnelGeneration)
                {
                    return;
                }

                if (matches.Count > 0)
                {
                    tunnelCandidateUrl = matches[matches.Count - 1].Value.TrimEnd('/');
                }

                if (sawRegistration && !tunnelRegistered)
                {
                    tunnelRegistered = true;
                    tunnelRegisteredUtc = DateTime.UtcNow;
                    nextPublicHealthCheckUtc = tunnelRegisteredUtc.AddSeconds(
                        TunnelHealthPolicy.PublicHealthInitialDelaySeconds);
                }

                if (tunnelRegistered &&
                    !String.IsNullOrEmpty(tunnelCandidateUrl) &&
                    !String.Equals(currentPublicUrl, tunnelCandidateUrl, StringComparison.OrdinalIgnoreCase))
                {
                    // Keep the generation check and persistence atomic with tunnel reset.
                    SetPublicUrl(tunnelCandidateUrl);
                    published = true;
                }
            }

            if (published && generation == Volatile.Read(ref tunnelGeneration))
            {
                SetStatus("异地联机地址已生成，正在等待公网域名生效...");
                SetReconnectEnabled(true);
            }
        }

        private void CaptureTunnelOutputFromLog(int generation)
        {
            try
            {
                if (generation != Volatile.Read(ref tunnelGeneration) ||
                    !File.Exists(tunnelLogPath))
                {
                    return;
                }

                DateTime logLastWriteUtc = File.GetLastWriteTimeUtc(tunnelLogPath);
                if (tunnelStartedUtc != DateTime.MinValue &&
                    logLastWriteUtc < tunnelStartedUtc.AddSeconds(-2))
                {
                    return;
                }

                string text;
                using (FileStream stream = new FileStream(
                    tunnelLogPath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Length > 256 * 1024)
                    {
                        stream.Seek(-256 * 1024, SeekOrigin.End);
                    }

                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 4096))
                    {
                        text = reader.ReadToEnd();
                    }
                }

                CaptureTunnelDiscovery(text, generation);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private void DrainProcessOutput(object sender, DataReceivedEventArgs args)
        {
            // Redirected streams must be drained so a long-running child cannot block.
        }

        private bool IsNodeRunning()
        {
            lock (processLock)
            {
                return IsProcessRunning(nodeProcess);
            }
        }

        private bool IsTunnelRunning()
        {
            lock (processLock)
            {
                return IsProcessRunning(tunnelProcess);
            }
        }

        private Process GetNodeProcessReference()
        {
            lock (processLock)
            {
                return nodeProcess;
            }
        }

        private Process GetTunnelProcessReference()
        {
            lock (processLock)
            {
                return tunnelProcess;
            }
        }

        private static bool IsProcessRunning(Process process)
        {
            if (process == null)
            {
                return false;
            }

            try
            {
                return !process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private void RestartTunnelWithBackoff(DateTime now)
        {
            StopTunnel();
            ClearTunnelState(true);
            ScheduleTunnelRetry(now);
        }

        private void ScheduleTunnelRetry(DateTime now)
        {
            int index = Math.Min(tunnelFailureCount, TunnelRetrySeconds.Length - 1);
            int delay = TunnelRetrySeconds[index];
            tunnelFailureCount = Math.Min(tunnelFailureCount + 1, TunnelRetrySeconds.Length - 1);
            nextTunnelStartUtc = now.AddSeconds(delay);
            SetStatus("异地联机正在自动重连，将在 " + delay + " 秒后重试...");
            SetReconnectEnabled(true);
        }

        private void StopNode()
        {
            Process process;
            lock (processLock)
            {
                process = nodeProcess;
                nodeProcess = null;
                PersistChildPidsLocked();
            }

            TerminateProcess(process);
        }

        private void StopTunnel()
        {
            Interlocked.Increment(ref tunnelGeneration);
            Process process;
            lock (processLock)
            {
                process = tunnelProcess;
                tunnelProcess = null;
                PersistChildPidsLocked();
            }

            TerminateProcess(process);
        }

        private void StopOwnedChildren()
        {
            StopTunnel();
            StopNode();
        }

        private static bool TerminateProcess(Process process)
        {
            if (process == null)
            {
                return true;
            }

            bool exited = false;
            try
            {
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        if (process.HasExited)
                        {
                            exited = true;
                            break;
                        }

                        process.Kill();
                        if (process.WaitForExit(2000))
                        {
                            exited = true;
                            break;
                        }
                    }
                    catch
                    {
                        try
                        {
                            if (process.HasExited)
                            {
                                exited = true;
                                break;
                            }
                        }
                        catch { }
                    }
                }
            }
            catch
            {
                // A process may exit naturally between HasExited and Kill.
            }
            finally
            {
                try { process.CancelOutputRead(); }
                catch { }
                try { process.CancelErrorRead(); }
                catch { }
                process.Dispose();
            }

            return exited;
        }

        private void InitializeChildJob()
        {
            IntPtr handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                return;
            }

            NativeMethods.JobObjectExtendedLimitInformation information =
                new NativeMethods.JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = NativeMethods.JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf(typeof(NativeMethods.JobObjectExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            bool configured = false;
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                configured = NativeMethods.SetInformationJobObject(
                    handle,
                    NativeMethods.JobObjectInfoType.ExtendedLimitInformation,
                    buffer,
                    (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (!configured)
            {
                NativeMethods.CloseHandle(handle);
                return;
            }

            lock (processLock)
            {
                childJobHandle = handle;
            }
        }

        private void AttachToChildJob(Process process)
        {
            try
            {
                lock (processLock)
                {
                    if (childJobHandle != IntPtr.Zero && !closing)
                    {
                        NativeMethods.AssignProcessToJobObject(childJobHandle, process.Handle);
                    }
                }
            }
            catch
            {
                // PID tracking and explicit shutdown remain available as fallbacks.
            }
        }

        private void CloseChildJob()
        {
            IntPtr handle;
            lock (processLock)
            {
                handle = childJobHandle;
                childJobHandle = IntPtr.Zero;
            }

            if (handle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(handle);
            }
        }

        private void CleanupRecordedChildren()
        {
            if (!File.Exists(childPidPath))
            {
                return;
            }

            bool allCleaned = true;
            try
            {
                string[] lines = File.ReadAllLines(childPidPath);
                foreach (string line in lines)
                {
                    string[] parts = line.Split(new char[] { '=' }, 2);
                    int processId;
                    if (parts.Length != 2 || !Int32.TryParse(parts[1], out processId))
                    {
                        continue;
                    }

                    string expectedPath = String.Equals(parts[0], "node", StringComparison.OrdinalIgnoreCase)
                        ? nodePath
                        : String.Equals(parts[0], "cloudflared", StringComparison.OrdinalIgnoreCase)
                            ? cloudflaredPath
                            : null;
                    if (expectedPath == null || processId == Process.GetCurrentProcess().Id)
                    {
                        continue;
                    }

                    Process process = null;
                    try
                    {
                        process = Process.GetProcessById(processId);
                        string actualPath = process.MainModule.FileName;
                        if (String.Equals(
                            Path.GetFullPath(actualPath),
                            Path.GetFullPath(expectedPath),
                            StringComparison.OrdinalIgnoreCase))
                        {
                            allCleaned = TerminateProcess(process) && allCleaned;
                            process = null;
                        }
                    }
                    catch (ArgumentException)
                    {
                        // The recorded process has already exited.
                    }
                    catch
                    {
                        allCleaned = false;
                    }
                    finally
                    {
                        if (process != null)
                        {
                            process.Dispose();
                        }
                    }
                }
            }
            catch
            {
                allCleaned = false;
            }

            if (allCleaned)
            {
                DeleteFileIfPresent(childPidPath);
            }
        }

        private void PersistChildPidsLocked()
        {
            string temporaryPath = childPidPath + ".tmp";
            try
            {
                int nodeId = GetRunningProcessId(nodeProcess);
                int tunnelId = GetRunningProcessId(tunnelProcess);
                if (nodeId == 0 && tunnelId == 0)
                {
                    DeleteFileIfPresent(temporaryPath);
                    DeleteFileIfPresent(childPidPath);
                    return;
                }

                StringBuilder content = new StringBuilder();
                if (nodeId != 0) content.AppendLine("node=" + nodeId);
                if (tunnelId != 0) content.AppendLine("cloudflared=" + tunnelId);
                File.WriteAllText(temporaryPath, content.ToString(), new UTF8Encoding(false));
                if (File.Exists(childPidPath))
                {
                    File.Replace(temporaryPath, childPidPath, null);
                }
                else
                {
                    File.Move(temporaryPath, childPidPath);
                }
            }
            catch
            {
                DeleteFileIfPresent(temporaryPath);
            }
        }

        private static int GetRunningProcessId(Process process)
        {
            try
            {
                return process != null && !process.HasExited ? process.Id : 0;
            }
            catch
            {
                return 0;
            }
        }

        private void ClearTunnelState(bool clearPublishedUrl)
        {
            lock (stateLock)
            {
                tunnelCandidateUrl = null;
                tunnelRegistered = false;
                tunnelRegisteredUtc = DateTime.MinValue;
                nextPublicHealthCheckUtc = DateTime.MinValue;
            }

            if (clearPublishedUrl)
            {
                SetPublicUrl(null);
            }
        }

        private void GetTunnelState(
            out string candidateUrl,
            out bool registered,
            out DateTime registeredUtc)
        {
            lock (stateLock)
            {
                candidateUrl = tunnelCandidateUrl;
                registered = tunnelRegistered;
                registeredUtc = tunnelRegisteredUtc;
            }
        }

        private string GetCurrentPublicUrl()
        {
            lock (stateLock)
            {
                return currentPublicUrl;
            }
        }

        private void SetPublicUrl(string url)
        {
            lock (stateLock)
            {
                currentPublicUrl = url;
                PersistCurrentUrl(url);
            }

            PostUi(delegate
            {
                publicUrlTextBox.Text = String.IsNullOrEmpty(url) ? "正在建立安全连接..." : url;
                copyButton.Enabled = !String.IsNullOrEmpty(url);
            });
        }

        private void PersistCurrentUrl(string url)
        {
            string temporaryPath = currentUrlPath + "." + Process.GetCurrentProcess().Id + ".tmp";
            try
            {
                if (String.IsNullOrEmpty(url))
                {
                    DeleteFileIfPresent(temporaryPath);
                    DeleteCurrentUrlFile();
                    return;
                }

                File.WriteAllText(temporaryPath, url + Environment.NewLine, new UTF8Encoding(false));
                if (File.Exists(currentUrlPath))
                {
                    File.Replace(temporaryPath, currentUrlPath, null);
                }
                else
                {
                    try
                    {
                        File.Move(temporaryPath, currentUrlPath);
                    }
                    catch (IOException)
                    {
                        if (!File.Exists(currentUrlPath))
                        {
                            throw;
                        }

                        File.Replace(temporaryPath, currentUrlPath, null);
                    }
                }
            }
            catch
            {
                DeleteFileIfPresent(temporaryPath);
            }
        }

        private void DeleteCurrentUrlFile()
        {
            DeleteFileIfPresent(currentUrlPath);
        }

        private static void DeleteFileIfPresent(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // URL persistence is diagnostic only and must never block startup.
            }
        }

        private void SetReconnectEnabled(bool enabled)
        {
            PostUi(delegate { reconnectButton.Enabled = enabled; });
        }

        private void SetStatus(string status)
        {
            lock (stateLock)
            {
                if (String.Equals(lastQueuedStatus, status, StringComparison.Ordinal))
                {
                    return;
                }

                lastQueuedStatus = status;
            }

            PostUi(delegate { statusLabel.Text = status; });
        }

        private void PostUi(MethodInvoker action)
        {
            if (closing || IsDisposed || Disposing || !IsHandleCreated)
            {
                return;
            }

            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    if (!closing && !IsDisposed && !Disposing)
                    {
                        action();
                    }
                });
            }
            catch (InvalidOperationException) { }
        }

        private void SetControlsForShutdown()
        {
            statusLabel.Text = "正在关闭游戏服务...";
            copyButton.Enabled = false;
            openButton.Enabled = false;
            reconnectButton.Enabled = false;
            exitButton.Enabled = false;
        }

        private static PublicHealthResult CheckHealthEndpoint(
            string baseUrl,
            int timeoutMilliseconds)
        {
            HttpWebRequest request = null;
            System.Threading.Timer abortTimer = null;
            int abortedForTimeout = 0;
            try
            {
                Uri healthUri = new Uri(new Uri(baseUrl), "health");
                request = (HttpWebRequest)WebRequest.Create(healthUri);
                request.Method = "GET";
                request.Timeout = timeoutMilliseconds;
                request.ReadWriteTimeout = timeoutMilliseconds;
                request.KeepAlive = false;
                request.AllowAutoRedirect = false;
                request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
                request.UserAgent = "ZaoluRaceLauncher/1.0";
                // Local and tunnel health checks must not inherit a stale desktop proxy.
                request.Proxy = null;

                abortTimer = new System.Threading.Timer(delegate
                {
                    Interlocked.Exchange(ref abortedForTimeout, 1);
                    try { request.Abort(); }
                    catch { }
                }, null, timeoutMilliseconds, Timeout.Infinite);

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        return PublicHealthResult.HttpFailure;
                    }

                    using (Stream stream = response.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream))
                    {
                        char[] buffer = new char[1024];
                        StringBuilder body = new StringBuilder(4096);
                        while (body.Length < 8192)
                        {
                            int remaining = Math.Min(buffer.Length, 8192 - body.Length);
                            int count = reader.Read(buffer, 0, remaining);
                            if (count <= 0)
                            {
                                break;
                            }

                            body.Append(buffer, 0, count);
                            string snapshot = body.ToString();
                            if (snapshot.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                snapshot.IndexOf("\"app\":\"zaolu-race\"", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                return PublicHealthResult.Ready;
                            }
                        }

                        return PublicHealthResult.HttpFailure;
                    }
                }
            }
            catch (WebException exception)
            {
                if (Volatile.Read(ref abortedForTimeout) != 0)
                {
                    return PublicHealthResult.Timeout;
                }

                return TunnelHealthPolicy.ClassifyWebException(exception.Status);
            }
            catch
            {
                return PublicHealthResult.TransportFailure;
            }
            finally
            {
                if (abortTimer != null)
                {
                    try { abortTimer.Change(Timeout.Infinite, Timeout.Infinite); }
                    catch { }
                    abortTimer.Dispose();
                }

                if (request != null)
                {
                    try { request.Abort(); }
                    catch { }
                }
            }
        }

        private static string QuoteArgument(string value)
        {
            if (String.IsNullOrEmpty(value))
            {
                return "\"\"";
            }

            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string ShortMessage(Exception exception)
        {
            string message = exception == null ? "未知错误" : exception.Message;
            if (String.IsNullOrWhiteSpace(message))
            {
                return "未知错误";
            }

            message = message.Replace("\r", " ").Replace("\n", " ").Trim();
            return message.Length > 110 ? message.Substring(0, 110) + "..." : message;
        }

        private static class NativeMethods
        {
            internal const uint JobObjectLimitKillOnJobClose = 0x00002000;

            internal enum JobObjectInfoType
            {
                ExtendedLimitInformation = 9
            }

            [StructLayout(LayoutKind.Sequential)]
            internal struct JobObjectBasicLimitInformation
            {
                internal long PerProcessUserTimeLimit;
                internal long PerJobUserTimeLimit;
                internal uint LimitFlags;
                internal UIntPtr MinimumWorkingSetSize;
                internal UIntPtr MaximumWorkingSetSize;
                internal uint ActiveProcessLimit;
                internal UIntPtr Affinity;
                internal uint PriorityClass;
                internal uint SchedulingClass;
            }

            [StructLayout(LayoutKind.Sequential)]
            internal struct IoCounters
            {
                internal ulong ReadOperationCount;
                internal ulong WriteOperationCount;
                internal ulong OtherOperationCount;
                internal ulong ReadTransferCount;
                internal ulong WriteTransferCount;
                internal ulong OtherTransferCount;
            }

            [StructLayout(LayoutKind.Sequential)]
            internal struct JobObjectExtendedLimitInformation
            {
                internal JobObjectBasicLimitInformation BasicLimitInformation;
                internal IoCounters IoInfo;
                internal UIntPtr ProcessMemoryLimit;
                internal UIntPtr JobMemoryLimit;
                internal UIntPtr PeakProcessMemoryUsed;
                internal UIntPtr PeakJobMemoryUsed;
            }

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
            internal static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            internal static extern bool SetInformationJobObject(
                IntPtr job,
                JobObjectInfoType informationClass,
                IntPtr information,
                uint informationLength);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            internal static extern bool CloseHandle(IntPtr handle);
        }
    }
}
