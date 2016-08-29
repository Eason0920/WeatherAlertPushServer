var net = require('net'),
    util = require('util'),
    moment = require('moment'),
    async = require('async'),
    fs = require('fs'),
    lock = new (require('rwlock'))(),
    request = require('request'),
    events = new (require('events').EventEmitter)(),
    emailModule = require('./lib/public/email-module.js'),
    appConfig = require('./app-config.js'),
    fileHandler = require('./lib/public/file-handler.js'),
    generalTools = require('./lib/public/general-tools.js');

var email;

//紀錄上次處理時間物件(依據天氣速報類型分別記錄)
var lastProcessingTimeObject = {
    '-eqa': null
};

//電子郵件資訊範本
var mailInfoModel = {
    identifier: '',
    weather_event: '',
    client_info: '',
    subject: '天氣速報通知',
    message: ''
};

//發送電子郵件事件
events.on('sendEmail', function (mailInfoObj) {

    //判斷是否需要初始化 email 模組
    if (!email) {
        email = new emailModule(
            appConfig.email_info.smtp,
            appConfig.email_info.port,
            appConfig.email_info.secure,
            appConfig.email_info.user,
            appConfig.email_info.pass
        );
    };

    //天氣類型中文說明
    var weatherEventDesc = (function () {
        switch (mailInfoObj.weather_event) {
            case '-eqa':
                return '地震速報';
            default:
                return '';
        }
    })();

    var mailContent = util.format('主機： %s:%s\r\n來源： %s\r\n類型： %s\r\n識別： %s\r\n訊息： %s\r\n時間： %s',
        appConfig.socket_server_ip,
        appConfig.socket_server_port,
        mailInfoObj.client_info || '',
        weatherEventDesc,
        mailInfoObj.identifier,
        mailInfoObj.message,
        moment().format('YYYY-MM-DD HH:mm:ss')
    );

    lock.writeLock(function (relesae) {
        email.sendMail(
            appConfig.email_info.sender,
            appConfig.email_info.receivers,
            mailInfoObj.subject,
            mailContent,
            null,
            function (err, info) {
                if (err) {      //寄發郵件發生錯誤，寫入 log
                    writeSystemLog(util.format('Tcp Socket Server 在寄送電子郵件通知時，發生無法預期的錯誤 (error： %s)', err), function () { });
                }

                relesae();
            }
        );
    });
});

//啟動 TCP Socket Server
var server = net.createServer()
    .listen(appConfig.socket_server_port,
    appConfig.socket_server_ip,
    function () {
        console.log('TCP Socket Server 服務啟動 (%s:%s)', appConfig.socket_server_ip, appConfig.socket_server_port);

        //TCP Socket Server 啟動時，檢查歷史紀錄目錄結構是否存在，若不存在則建立(目前僅有地震速報)
        fileHandler.createFileIfNotExists(
            appConfig.history_info.dir,
            appConfig.history_info.history_list[0].file_name,
            appConfig.history_info.history_list[0].content_struct,
            function (err) {
                if (err) {      //若建立歷史紀錄目錄結構失敗則關閉伺服器
                    server.close(function () {
                        writeSystemLog(util.format('建立地震速報歷史紀錄目錄結構發生無法預期的錯誤，Tcp Socket Server 即將關閉 (error： %s)', err), function () { });
                    });
                }
            });
    });

//tcp socket server 發生錯誤
server.on('error', function (e) {
    var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
    mailInfoObj.message = util.format('Tcp Socket Server 發生無法預期的錯誤 (error： %s)', e);
    events.emit('sendEmail', mailInfoObj);
});

//tcp socket server 停止服務
server.on('close', function () {
    var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
    mailInfoObj.message = 'Tcp Socket Server 即將關閉，請查看事件紀錄 log 檔';
    events.emit('sendEmail', mailInfoObj);
});

//client 端開始連線
server.on('connection', function (socket) {
    socket.setEncoding('utf8');     //將編碼設定為utf8，便會自動將緩衝轉換為字串
    socket.client_info = socket.remoteAddress + ':' + socket.remotePort;       //儲存 client 的 ip 與 port
    console.log('TCP Socket Client 連線開始 (%s)', socket.client_info);

    //接收到 socket 資料
    var completeData = '';
    socket.on('data', function (data) {

        //利用推送資料完整結束點標記來判斷資料是否接收完成
        //因 tcp Socket 接收資料不會一次將完整資料送過來，會拆開成一段一段 buffer 進來
        completeData += data;
        var index = completeData.indexOf(appConfig.push_end_point);
        if (index > -1) {
            completeData = completeData.substring(0, index);

            //將取得的推送資料轉換為 json 物件後分別儲存至目前 socket 的自定義屬性
            var json = JSON.parse(completeData);
            socket.sequence = json.sequence;        //程序唯一識別碼
            socket.weather_event = json.push_type.toLowerCase();      //發送類型
            socket.push_content = json.push_content;        //要產生文字檔的內容
            socket.is_test = json.is_test;      //資料是否為測試用
            socket.identifier = json.identifier;        //client 端執行 cap 唯一識別碼
            socket.use_version = json.use_version;        //要使用的版本編號
            completeData = '';

            //建立已經收到天氣速報資料 log 檔
            writeEventLog(socket, '已接收到 TCP Socket Client 傳入的天氣速報資料，開始產生文字檔作業');

            //判斷是否需要延遲處理
            if (!appConfig.delay_processing_seconds_info.use_delay) {

                //產生工程部 txt 檔案
                dataProcess(socket);
            } else {

                //檢查距離上次處理結束後是否還在進行延遲處理中
                if (checkLastProcessingInDelay(socket.weather_event)) {     //已超過上次處理後的延遲時間，繼續處理
                    dataProcess(socket);        //產生工程部 txt 檔案
                } else {        //距離上次處理時間延遲忽略範圍內，忽略並回傳成功代碼
                    var logMessage;
                    var lastProcessingTime = lastProcessingTimeObject[socket.weather_event];        //依據天氣速報類型取得上一次完成時間
                    var currentTime = moment();     //當前時間
                    var delayProcessingSeconds = appConfig.delay_processing_seconds_info.weather_event[socket.weather_event];     //延遲處理秒數設定值

                    if (socket.writable) {
                        socket.write('1');
                        logMessage = util.format('接收到的天氣速報資料類型，距離上次處理完成時間還在延遲忽略範圍內 (weatherEvent： %s，last： %s，current： %s，diff： %s，delaySet： %s)',
                            socket.weather_event,
                            lastProcessingTime.format('YYYYMMDDHHmmss'),
                            currentTime.format('YYYYMMDDHHmmss'),
                            currentTime.diff(lastProcessingTime, 'seconds'),
                            delayProcessingSeconds);
                    } else {
                        socket.destroy();
                        logMessage = util.format('接收到的天氣速報資料類型，距離上次處理完成時間還在延遲忽略範圍內，而且發生客戶端無法回應結果的錯誤 (weatherEvent： %s，last： %s，current： %s，diff： %s，delaySet： %s，event： socket.writable = false)',
                            socket.weather_event,
                            lastProcessingTime.format('YYYYMMDDHHmmss'),
                            currentTime.format('YYYYMMDDHHmmss'),
                            currentTime.diff(lastProcessingTime, 'seconds'),
                            delayProcessingSeconds);
                    }

                    //send email
                    var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
                    mailInfoObj.weather_event = socket.weather_event;
                    mailInfoObj.client_info = socket.client_info;
                    mailInfoObj.identifier = socket.identifier;
                    mailInfoObj.message = logMessage;
                    events.emit('sendEmail', mailInfoObj);

                    //log 紀錄
                    writeEventLog(socket, logMessage);
                }
            }
        };
    });

    //client 與 server 關閉連線
    socket.on('end', function () {
        console.log('TCP Socket Client 連線結束 (' + socket.client_info + ')');
    });

    //client 與 socket server 發生連線錯誤
    socket.on('error', function (e) {
        var logMessage = util.format('TCP Socket Client 發生無法預期的連線錯誤 (error： %s)', e);
        var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
        mailInfoObj.weather_event = socket.weather_event;
        mailInfoObj.client_info = socket.client_info;
        mailInfoObj.identifier = socket.identifier;
        mailInfoObj.message = logMessage;
        events.emit('sendEmail', mailInfoObj);

        writeEventLog(socket, logMessage);
    });
});

/**
 * 處理 json 資料傳換為工程部 txt 檔案
 * 
 * socket： 當前 socket
 */
function dataProcess(socket) {

    /**
     * 檢查傳入的 cap 檔名是否已存在歷史紀錄內
     * 
     * resultCode：
     * 1： 傳入的 cap 檔名尚未處理過
     * -2： 傳入的 cap 檔名已處理過
     * -3： 讀取地震速報歷史失敗
     */
    checkCapIsProcessed(socket, function (err, resultCode) {

        //是否需要發送至 Line 平台識別
        var isPushToLine = false;

        //寄發郵件資訊 json 物件
        var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
        mailInfoObj.weather_event = socket.weather_event;
        mailInfoObj.client_info = socket.client_info;
        mailInfoObj.identifier = socket.identifier;

        if (resultCode == 1) {     //傳入的 cap 檔名尚未處理過

            socket.push_content += '\r\n\r\n';        //依據工程部要求每份資料多加空行

            //依據發送類型建立地震文字檔檔名
            var txtFileName = (function () {
                var fileName = '';
                switch (socket.weather_event) {
                    case '-eqa'://地震速報

                        //判斷是否為測試資料與使用版本編號來決定文字檔名稱
                        if (socket.is_test != 1) {      //正式

                            //地震速報目前只有在第二版才進行歷史紀錄檢查
                            switch (socket.use_version) {
                                case '2':
                                    fileName = appConfig.engineering_earthquake_file_v2;
                                    break;
                                default:
                                    return appConfig.engineering_earthquake_file;
                            }
                        } else {        //測試
                            switch (socket.use_version) {
                                case '2':
                                    fileName = appConfig.engineering_earthquake_test_file_v2;
                                    break;
                                default:
                                    return appConfig.engineering_earthquake_test_file;
                            }
                        }
                        break;
                }

                return fileName;
            })();

            //產生工程部地震資訊文字檔案(依據設定檔陣列決定產生文字檔位置)
            //使用 async.mapSeries 同一時間只使用單一非同步運算，若資料處理失敗即跳至 callback 處理，並中斷後續操作
            //使用臨時副檔名，以預防建立多個位置文字檔發生時發生錯誤造成檔案不一致問題
            var tempExt = '.temp' + moment().format('YYYYMMDDHHmmss');
            var resClientCode;
            var logMessage;

            async.mapSeries(appConfig.engineering_earthquake_paths, function (path, callback) {
                lock.writeLock(function (release) {
                    fileHandler.createOrWriteFile(path, (txtFileName + tempExt), socket.push_content, function (err) {

                        //將處理結果回傳給 callback，若第一個參數不為 null，則表示建立文字檔發生錯誤，迴圈則會中斷並呼叫 callback處理
                        callback(err, path + (txtFileName + tempExt));
                        release();
                    });
                });
            }, function (err, tempExtPaths) {       //callback 回應處理(錯誤資訊, 文字檔路徑陣列)
                if (!err) {     //建立文字檔成功

                    //建立文字檔成功後，將文字檔臨時副檔名還原
                    removeFilesTempExt(tempExtPaths, tempExt, function (err, renameSuccessPaths) {
                        if (!err) {     //還原文字檔臨時副檔名成功
                            if (socket.is_test != 1 && socket.use_version == 2) {       //建立文字檔成功後，只有在正式模式與地震速報第二版才寫入歷史記錄
                                storeProcessedCapInfo(socket, function (err) {
                                    if (!err && socket.writable) {
                                        resClientCode = 1;
                                        logMessage = util.format('建立天氣速報資料文字檔與寫入歷史記錄檔成功 (paths： %s)',
                                            generalTools.concatStringArray(renameSuccessPaths, ','));

                                    } else if (!err && !socket.writable) {
                                        resClientCode = null;
                                        logMessage = util.format('建立天氣速報資料文字檔與寫入歷史記錄檔成功，但發生客戶端無法回應結果的錯誤 (event： socket.writable = false，paths： %s)',
                                            generalTools.concatStringArray(renameSuccessPaths, ',') + txtFileName);

                                    } else if (err && socket.writable) {
                                        resClientCode = 2;
                                        logMessage = util.format('建立天氣速報資料文字檔成功，但寫入歷史記錄檔發生無法預期的錯誤 (paths： %s，error： %s)',
                                            generalTools.concatStringArray(renameSuccessPaths, ','), err);

                                    } else if (err && !socket.writable) {
                                        resClientCode = null;
                                        logMessage = util.format('建立天氣速報資料文字檔成功，但寫入歷史記錄檔發生無法預期的錯誤，而且發生客戶端無法回應結果的錯誤 (event： socket.writable = false，paths： %s，error： %s)',
                                            generalTools.concatStringArray(renameSuccessPaths, ','), err);
                                    }

                                    //使用流程控制同時執行
                                    async.parallel({

                                        //判斷要回應的代碼變數是否有值，若無值則表示發生客戶端無法回應結果的錯誤，並銷毀此 socket 連線
                                        socket_write: function (callback) {
                                            if (resClientCode) {
                                                socket.write(resClientCode.toString());
                                            } else {
                                                socket.destroy();
                                            }

                                            callback(null, null);
                                        },

                                        //寄發訊息郵件
                                        send_email: function (callback) {
                                            if (appConfig.processed_successful_send_mail) {
                                                mailInfoObj.message = logMessage;
                                                events.emit('sendEmail', mailInfoObj);
                                            }

                                            callback(null, null);
                                        },

                                        //工程部文字檔處理結果紀錄
                                        create_txt_result: function (callback) {
                                            writeEventLog(socket, logMessage, function (err) {
                                                callback(null, null);     //若寫入文字檔失敗暫不處理
                                            });
                                        },

                                        //推播天氣速報訊息至 Line 平台
                                        push_line: function (callback) {
                                            pushLineMessage(socket.weather_event, socket.push_content, function (err, res) {
                                                callback(err, res);
                                            });
                                        }
                                    }, function (err, result) {        //目前只捕捉推播天氣速報訊息至 Line 平台的錯誤
                                        var logMessage;

                                        if (err) {      //推播天氣速報訊息至 Line 平台發生網路錯誤
                                            logMessage = util.format('推播天氣速報資料至 Line 平台發生無法預期的錯誤 (error： %s)', err);
                                        } else {
                                            var responseBodyJson = JSON.parse(result.push_line.body);

                                            if (responseBodyJson.result_code != 1) {        //推播天氣速報訊息至 Line 平台發生處理程序錯誤
                                                logMessage = util.format('推播天氣速報資料至 Line 平台發生無法預期的錯誤 (result_code： %s，result_message： %s)',
                                                    responseBodyJson.result_code, responseBodyJson.result_message);
                                            } else {
                                                logMessage = '推播天氣速報資料至 Line 平台發送成功';
                                            }
                                        }

                                        //使用流程控制同時執行
                                        async.parallel({
                                            write_log: function (callback) {
                                                writeEventLog(socket, logMessage, function (err) {
                                                    callback(null);
                                                });
                                            },
                                            send_email: function (callback) {
                                                mailInfoObj.message = logMessage;
                                                events.emit('sendEmail', mailInfoObj);
                                                callback(null);
                                            }
                                        }, function (err, result) {
                                            //若寫入推播 log 紀錄與寄送電子郵件發生錯誤暫不處理(應該不會那麼慘吧。。。)
                                        });
                                    });
                                });
                            } else {        //建立文字檔成功但不須寫入歷史紀錄
                                if (socket.writable) {
                                    resClientCode = 1;
                                    logMessage = util.format('建立天氣速報資料文字檔成功 (paths： %s)',
                                        generalTools.concatStringArray(renameSuccessPaths, ','));

                                } else {
                                    resClientCode = null;
                                    logMessage = util.format('建立天氣速報資料文字檔成功，但發生客戶端無法回應結果的錯誤 (event： socket.writable = false，paths： %s)',
                                        generalTools.concatStringArray(renameSuccessPaths, ','));
                                }

                                //判斷要回應的代碼變數是否有值，若無值則表示發生客戶端無法回應結果的錯誤，並銷毀此 socket 連線
                                if (resClientCode) {
                                    socket.write(resClientCode.toString());
                                } else {
                                    socket.destroy();
                                }

                                //寄發訊息郵件
                                if (appConfig.processed_successful_send_mail) {
                                    mailInfoObj.message = logMessage;
                                    events.emit('sendEmail', mailInfoObj);
                                }

                                //log 紀錄
                                writeEventLog(socket, logMessage);
                            }

                            //文字檔產生完成，紀錄當下時間
                            lastProcessingTimeObject[socket.weather_event] = moment();

                        } else {        //還原文字檔臨時副檔名失敗
                            if (socket.writable) {
                                resClientCode = 0;
                                logMessage = util.format('建立天氣速報資料文字檔成功，但還原臨時副檔名發生無法預期的錯誤 (paths： %s， error： %s)',
                                    generalTools.concatStringArray(tempExtPaths, ','), err);

                            } else {
                                resClientCode = null;
                                logMessage = util.format('建立天氣速報資料文字檔成功，但還原臨時副檔名發生無法預期的錯誤，而且發生客戶端無法回應結果的錯誤 (event： socket.writable = false，paths： %s， error： %s)',
                                    generalTools.concatStringArray(tempExtPaths, ','), err);
                            }

                            //判斷要回應的代碼變數是否有值，若無值則表示發生客戶端無法回應結果的錯誤，並銷毀此 socket 連線
                            if (resClientCode) {
                                socket.write(resClientCode.toString());
                            } else {
                                socket.destroy();
                            }

                            //寄發訊息郵件
                            mailInfoObj.message = logMessage;
                            events.emit('sendEmail', mailInfoObj);

                            //log 紀錄
                            writeEventLog(socket, logMessage);
                        }
                    });

                } else {        //建立文字檔失敗

                    //固定取文字檔路徑陣列最後一筆進行 log 紀錄
                    if (socket.writable) {
                        resClientCode = -1;
                        logMessage = util.format('建立天氣速報資料文字檔失敗 (path： %s，error： %s)',
                            generalTools.concatStringArray(tempExtPaths, ','), err);
                    } else {
                        resClientCode = null;
                        logMessage = util.format('建立天氣速報資料文字檔失敗，而且發生客戶端無法回應結果的錯誤 (event： socket.writable = false，path： %s，error： %s)',
                            generalTools.concatStringArray(tempExtPaths, ','), err);
                    }

                    //判斷要回應的代碼變數是否有值，若無值則表示發生客戶端無法回應結果的錯誤，並銷毀此 socket 連線
                    if (resClientCode) {
                        socket.write(resClientCode.toString());
                    } else {
                        socket.destroy();
                    }

                    //寄發訊息郵件
                    mailInfoObj.message = logMessage;
                    events.emit('sendEmail', mailInfoObj);

                    //log 紀錄
                    writeEventLog(socket, logMessage);
                }
            });

        } else {        //傳入的 cap 檔名已重複：-2，讀取歷史記錄失敗：-3
            if (socket.writable) {
                resClientCode = resultCode;

                if (resultCode == -2) {
                    logMessage = util.format('傳入的天氣速報資料在歷史紀錄內發現重複 (identifier： %s)', socket.identifier);
                } else if (resultCode == -3) {
                    logMessage = util.format('讀取歷史紀錄檔內容發生無法預期的錯誤 (error： %s)', err);
                }

            } else {
                resClientCode = null;

                if (resultCode == -2) {
                    logMessage = util.format('傳入的天氣速報資料在歷史紀錄內發現重複，但發生客戶端無法回應結果的錯誤 (event： socket.writable = false，identifier： %s)', socket.identifier);
                } else if (resultCode == -3) {
                    logMessage = util.format('讀取歷史紀錄檔內容發生無法預期的錯誤，而且發生客戶端無法回應結果的錯誤 (event： socket.writable = false，error： %s)', err);
                }
            }

            //判斷要回應的代碼變數是否有值，若無值則表示發生客戶端無法回應結果的錯誤，並銷毀此 socket 連線
            if (resClientCode) {
                socket.write(resClientCode.toString());
            } else {
                socket.destroy();
            }

            //寄發訊息郵件
            mailInfoObj.message = logMessage;
            events.emit('sendEmail', mailInfoObj);

            //log 紀錄
            writeEventLog(socket, logMessage);
        }
    });
};

/**
 * 移除文件臨時副檔名
 * 
 * paths： 文件路徑檔名陣列
 * removeExt： 要移除的副檔名稱
 * callback： 回應函式
 */
function removeFilesTempExt(paths, removeExt, callback) {
    async.mapSeries(paths, function (path, callback) {
        var newPath = path.replace(removeExt, '');
        lock.writeLock(function (release) {
            fs.rename(path, newPath, function (err) {
                callback(err, newPath);
                release();
            });
        });
    }, function (err, paths) {
        callback(err, paths);
    });
};

/**
 * 移除文件
 * 
 * paths： 文件路徑陣列
 * callback： 回應函式
 */
function deleteFiles(paths, callback) {
    async.each(paths, function (path, callback) {
        lock.writeLock(function (release) {
            fs.unlink(path, function (err) {
                callback(err);
                release();
            });
        });
    }, function (err) {
        callback(err);
    });
};


/**
 * 檢查傳入的 cap 檔名是否已存在歷史紀錄內
 * 
 * socket： 當前 socket
 * callback： 回應函式
 */
function checkCapIsProcessed(socket, callback) {

    //只有在正式模式下才進行歷史紀錄檢查
    if (socket.is_test != 1) {
        switch (socket.weather_event) {
            case '-eqa'://地震速報

                //地震速報目前只有在第二版才進行歷史紀錄檢查
                switch (socket.use_version) {
                    case '2':

                        //cap 歷史記錄 json 檔案位置
                        var processedFilePath = util.format('%s\\%s',
                            appConfig.history_info.dir,
                            appConfig.history_info.history_list[0].file_name
                        );

                        //讀取歷史記錄 json 檔案
                        lock.readLock(function (release) {
                            fileHandler.readFileContent(processedFilePath, function (err, content) {
                                if (!err) {      //讀取地震速報歷史成功

                                    //將歷史資料存入當前 socket，供後續使用 
                                    socket.history_json = JSON.parse(content);

                                    //傳入的 cap 檔名是否有存在於歷史紀錄中
                                    if (socket.history_json.processed_caps.indexOf(socket.identifier) === -1) {
                                        callback(null, 1);
                                    } else {
                                        callback(null, -2);
                                    }

                                } else {        //讀取地震速報歷史失敗
                                    callback(err, -3);
                                }

                                release();
                            });
                        });

                        break;
                    default:
                        callback(null, 1);
                }

                break;
        }
    } else {        //測試模式下忽略歷史紀錄檢查
        callback(null, 1);
    }
};

/**
 * 將已完成的天氣速報資料 cap 資訊存入歷史紀錄
 * 
 * socket： 當前 socket
 * callback： 回應函式
 */
function storeProcessedCapInfo(socket, callback) {
    switch (socket.weather_event) {
        case '-eqa'://地震速報

            //判斷歷史紀錄內存放地震速報 cap 檔名數量是否已達存放上限，若有則移除第一筆
            if (socket.history_json.processed_caps.length === appConfig.store_processed_count) {
                socket.history_json.processed_caps.shift();
            }

            //將最新的地震速報加入至已處理過的歷史紀錄最後一筆
            socket.history_json.processed_caps.push(socket.identifier);

            lock.writeLock(function (release) {
                fileHandler.createOrWriteFile(
                    appConfig.history_info.dir,
                    appConfig.history_info.history_list[0].file_name,
                    JSON.stringify(socket.history_json),
                    function (err) {
                        callback(err);
                        release();
                    }
                );
            });

            break;
    }
};

/**
 * 依據天氣速報類型檢查目前時間與上次處理時間是否已超過延遲處理時間
 *
 * weatherEvent： 天氣速報類型
 */
function checkLastProcessingInDelay(weatherEvent) {
    var lastProcessingTime = lastProcessingTimeObject[weatherEvent];        //上一次處理時間
    var delayProcessingSeconds = appConfig.delay_processing_seconds_info.weather_event[weatherEvent];     //延遲秒數

    if (lastProcessingTime) {
        var currentTime = moment();

        //判斷接收資料的時候是否有大於延遲處理時間(利用秒數判斷)
        if (currentTime.diff(lastProcessingTime, 'seconds') > delayProcessingSeconds) {
            return true;
        }

        return false;
    }

    return true;
};

/**
 * 發送天氣速報即時訊息至 Line 推播 API
 * weatherEvent： 天氣速報類型
 * contents： 要推播的天氣速報內容(依據天氣速報類型傳入的內容格式不一定會是固定的，好處理就可以)
 * callback： 回應函式
 */
function pushLineMessage(weatherEvent, contents, callback) {
    if (weatherEvent && contents) {
        var weatherEventCode;
        var pushMessage;

        try {
            //依據天氣速報類型決定要推播的文字訊息格式
            switch (weatherEvent) {
                case '-eqa':        //地震速報
                    var contentAry = contents.split('##');
                    weatherEventCode = 1;       //推播天氣類型代碼(0：全部、1：地震速報、2：雷雨速報)
                    pushMessage = util.format('【%s】\r\n\r\n%s\r\n\r\n%s\r\n\r\n%s',
                        '地震速報', contentAry[1].trim(), contentAry[2].trim(), contentAry[3].trim());

                    break;
            }

            request(
                {
                    method: 'post',
                    url: appConfig.push_line_message_url,
                    form: {
                        weather_event_code: weatherEventCode,
                        push_message: pushMessage
                    }
                }, function (err, res, body) {
                    if (callback) {
                        callback(err, res);
                    }
                }
            );
        } catch (ex) {
            if (callback) {
                callback(ex);
            }
        }
    }
};

/**
 * 事件紀錄 log 檔處理
 * 
 * socket： 當前 socket
 * logMessage： log 訊息
 * callback： 回應函式
 */
function writeEventLog(socket, logMessage, callback) {

    //依據發送類型建立事件 log 目錄，存放在專案目錄下
    var logPath = (function () {
        var path = __dirname + '\\';
        switch (socket.weather_event) {
            case '-eqa'://地震速報

                //判斷是否為測試資料
                path += ((socket.is_test != 1) ? appConfig.earthquake_log_folder : appConfig.earthquake_log_test_folder) + '\\';
                break;
        }

        return path;
    })();

    //log 檔案名稱開頭加上目前日期
    var logFileName = moment().format('YYYY-MM-DD') + '_' + appConfig.log_file_name;

    //檔案內容開頭加上目前時間
    logMessage = socket.sequence + ' - ' + moment().format('HH:mm:ss') + ' - ' + logMessage + ' - ' + socket.identifier + '\r\n\r\n';

    //產生 log 紀錄檔案
    lock.writeLock(function (release) {
        fileHandler.createOrAppendFile(logPath, logFileName, logMessage, function (err) {
            if (!err) {
                console.log(util.format('TCP Socket Server 寫入流程處理記錄檔成功 (%s)： %s', socket.client_info, logMessage));
            } else {
                console.log(util.format('TCP Socket Server 寫入流程處理記錄檔發生無法預期的錯誤 (%s)： %s', socket.client_info, err));
            }

            if (callback) {
                callback(err);
            }

            release();
        });
    });
};

/**
 * 系統事件紀錄 log 檔處理
 * 
 * logMessage： log 訊息
 * callback： 回應函式
 */
function writeSystemLog(logMessage, callback) {

    var systemLogDir = util.format('%s\\%s\\', __dirname, appConfig.system_log_folder);

    //log 檔案名稱開頭加上目前日期
    var logFileName = moment().format('YYYY-MM-DD') + '_' + appConfig.log_file_name;

    //檔案內容開頭加上目前時間
    logMessage = moment().format('HH:mm:ss') + ' - ' + logMessage + '\r\n\r\n';

    //產生 log 紀錄檔案
    lock.writeLock(function (release) {
        fileHandler.createOrAppendFile(systemLogDir, logFileName, logMessage, function (err) {
            if (!err) {
                console.log(util.format('TCP Socket Server 寫入系統記錄檔成功： %s', logMessage));
            } else {
                console.log(util.format('TCP Socket Server 寫入系統記錄檔發生無法預期的錯誤： %s', err));
            }

            if (callback) {
                callback(err);
            }

            release();
        });
    });
};

