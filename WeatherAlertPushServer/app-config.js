module.exports = {

    //全域通用設定
    socket_server_ip: '',      //socket 伺服器 ip
    socket_server_port: 5678,       //socket 伺服器埠號
    push_end_point: '#%PUSH_END_POINT#%',       //接收推送資料結束點
    log_file_name: 'log.txt',        //存放天氣速報 log 檔名
    system_log_folder: 'system_log',      //存放系統 log 紀錄資料夾
    store_processed_count: 5,       //存放天氣速報已處理過的 cap 檔名數量
    processed_successful_send_mail: true,       //程序若處理成功是否寄發電子郵件通知
    push_line_message_url: 'push_line_message_url',

    //地震速報相關設定資訊
    engineering_earthquake_paths: ['D:\\engineering_earthquake\\', 'D:\\engineering_earthquake2\\'],      //工程部存放地震速報文字檔路徑(多個位置)
    engineering_earthquake_file: 'alarm_eq.txt',        //工程部地震速報文字檔名
    engineering_earthquake_file_v2: 'alarm_eq2.txt',        //工程部地震速報文字檔名(第二版)
    engineering_earthquake_test_file: 'test_alarm_eq.txt',        //工程部地震速報文字檔名(測試)
    engineering_earthquake_test_file_v2: 'test_alarm_eq2.txt',        //工程部地震速報文字檔名(測試)(第二版)
    earthquake_log_folder: 'earthquake_log',      //存放地震速報 log 檔資料夾
    earthquake_log_test_folder: 'earthquake_log_test',      //存放地震速報 log 檔資料夾(測試)

    //歷史紀錄檔案相關資訊(目前僅有地震速報)
    history_info: {
        dir: require('util').format('%s\\%s\\', __dirname, 'weather_history'),     //存放路徑
        history_list: [     //各項歷史紀錄列表
            {
                file_name: 'earthquake_history.json',     //檔名
                content_struct: '{"processed_caps": []}'      //內容結構
            }
        ]
    },

    //寄發電子郵件主機資訊
    email_info: {
        user: 'user',
        pass: 'pass',
        secure: false,
        smtp: 'smtp',
        port: 25,
        sender: '天氣速報 <sender@mail>',
        receivers: ['receivers']
    },

    //延遲處理秒數(依據天氣速報類型分別定義)
    delay_processing_seconds_info: {
        use_delay: true,
        weather_event: {
            '-eqa': 35
        }
    },
}