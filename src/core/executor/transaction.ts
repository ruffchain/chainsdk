const assert = require('assert');
import {ErrorCode} from '../error_code';
import {Chain, BlockHeader, Storage, Transaction, EventLog, Receipt, ReceiptSourceType} from '../chain';
import {TxListener, BlockHeightListener, ChainEventDefinations, BaseHandler} from './handler';

import { LoggerInstance } from '../lib/logger_util';
import { isNumber } from 'util';
import { addressFromPublicKey } from '../../client';
const {LogShim} = require('../lib/log_shim');

export type TransactionExecuteflag = {
    ignoreNoce?: boolean
};

class BaseExecutor {
    protected m_logger: LoggerInstance;
    protected m_logs: EventLog[] = [];
    protected m_eventDefinations: ChainEventDefinations;
    constructor(options: {eventDefinations: ChainEventDefinations, logger: LoggerInstance}) {
        this.m_logger = options.logger;
        this.m_eventDefinations = options.eventDefinations;
    }
    protected async prepareContext(blockHeader: BlockHeader, storage: Storage, externContext: any): Promise<any> {
        let database =  (await storage.getReadWritableDatabase(Chain.dbUser)).value!;
        let context = Object.create(externContext);
        
        // context.getNow = (): number => {
        //     return blockHeader.timestamp;
        // };

        Object.defineProperty(
            context, 'now', {
                writable: false,
                value: blockHeader.timestamp
            } 
        );

        Object.defineProperty(
            context, 'height', {
                writable: false,
                value: blockHeader.number
            } 
        );

        Object.defineProperty(
            context, 'storage', {
                writable: false,
                value: database
            } 
        );

        context.emit = (name: string, param?: any) => {
            if (this.m_eventDefinations.has(name)) {
                let log: EventLog = new EventLog();
                log.name = name;
                log.param = param;
                this.m_logs.push(log);
            } else {
                this.m_logger.error(`undefined event ${name}`);
                assert(false, `undefined event ${name}`);
            }
        };

        return context;
    }
}

export class TransactionExecutor extends BaseExecutor {
    protected m_listener: TxListener;
    protected m_tx: Transaction;
    protected m_addrIndex = 0;

    constructor(handler: BaseHandler, listener: TxListener, tx: Transaction, logger: LoggerInstance) {
        super({
            eventDefinations: handler.getEventDefinations(),
            logger: new LogShim(logger).bind(`[transaction: ${tx.hash}]`, true).log
        });
        this.m_listener = listener;
        this.m_tx = tx;
    }

    protected async _dealNonce(tx: Transaction, storage: Storage): Promise<ErrorCode> {
        // 检查nonce
        let kvr = await storage.getKeyValue(Chain.dbSystem, Chain.kvNonce);
        if (kvr.err !== ErrorCode.RESULT_OK) {
            this.m_logger.error(`methodexecutor, _dealNonce, getReadWritableKeyValue failed`);
            return kvr.err;
        }
        let nonce: number = -1;
        let nonceInfo = await kvr.kv!.get(tx.address!);
        if (nonceInfo.err === ErrorCode.RESULT_OK) {
           nonce = nonceInfo.value as number;
        }
        if (tx.nonce !== nonce + 1) {
            this.m_logger.error(`methodexecutor, _dealNonce, nonce error,nonce should ${nonce + 1}, but ${tx.nonce}, txhash=${tx.hash} address=${tx.address}`);
            return ErrorCode.RESULT_ERROR_NONCE_IN_TX;
        }
        await kvr.kv!.set(tx.address!, tx.nonce);
        return ErrorCode.RESULT_OK;
    }

    public async execute(blockHeader: BlockHeader, storage: Storage, externContext: any, flag?: TransactionExecuteflag): Promise<{err: ErrorCode, receipt?: Receipt}> {
        if (!(flag && flag.ignoreNoce)) {
            let nonceErr = await this._dealNonce(this.m_tx, storage);
            if (nonceErr !== ErrorCode.RESULT_OK) {
                return {err: nonceErr};
            }
        }
        let context = await this.prepareContext(blockHeader, storage, externContext);
        let receipt: Receipt = new Receipt();
        let work = await storage.beginTransaction();
        if (work.err) {
            this.m_logger.error(`methodexecutor, beginTransaction error,storagefile=${storage.filePath}`);
            return {err: work.err};
        }
         
        receipt.returnCode = await this._execute(context, this.m_tx.input);
        assert(isNumber(receipt.returnCode), `invalid handler return code ${receipt.returnCode}`);
        if (!isNumber(receipt.returnCode)) {
            this.m_logger.error(`methodexecutor failed for invalid handler return code type, return=`, receipt.returnCode);
            return {err: ErrorCode.RESULT_INVALID_PARAM};
        }
        receipt.setSource({sourceType: ReceiptSourceType.transaction, txHash: this.m_tx.hash});
        if (receipt.returnCode) {
            this.m_logger.warn(`handler return code=${receipt.returnCode}, will rollback storage`);
            await work.value!.rollback();
        } else {
            this.m_logger.debug(`handler return code ${receipt.returnCode}, will commit storage`);
            let err = await work.value!.commit();
            if (err) {
                this.m_logger.error(`methodexecutor, transaction commit error, err=${err}, storagefile=${storage.filePath}`);
                return {err};
            }
            receipt.eventLogs = this.m_logs;
        }
        
        return {err: ErrorCode.RESULT_OK, receipt};
    }

    protected async _execute(env: any, input: any): Promise<ErrorCode> {
        try {
            this.m_logger.info(`will execute tx ${this.m_tx.hash}: ${this.m_tx.method},from ${this.m_tx.address}, params ${JSON.stringify(this.m_tx.input)}`);
            return await this.m_listener(env, this.m_tx.input);
        } catch (e) {
            this.m_logger.error(`execute method linstener e=`, e.stack);
            return ErrorCode.RESULT_EXECUTE_ERROR;
        }
    }

    protected async prepareContext(blockHeader: BlockHeader, storage: Storage, externContext: any): Promise<any> {
        let context = await super.prepareContext(blockHeader, storage, externContext);

        // 执行上下文

        Object.defineProperty(
            context, 'caller', {
                writable: false,
                value: this.m_tx.address!
            } 
        );

        context.createAddress = () => {
            let buf = Buffer.from(this.m_tx.address! + this.m_tx.nonce + this.m_addrIndex);
            this.m_addrIndex++;
            return addressFromPublicKey(buf);
        };

        return context;
    }
}

export class EventExecutor extends BaseExecutor {
    protected m_listener: BlockHeightListener;
    protected m_bBeforeBlockExec = true;

    constructor(handler: BaseHandler, listener: BlockHeightListener, logger: LoggerInstance) {
        super({
            eventDefinations: handler.getEventDefinations(), 
            logger 
        });
        this.m_listener = listener;
    }

    public async execute(blockHeader: BlockHeader, storage: Storage, externalContext: any): Promise<{err: ErrorCode, receipt?: Receipt}> {
        this.m_logger.debug(`execute event on ${blockHeader.number}`);
        let context: any = await this.prepareContext(blockHeader, storage, externalContext);
        let work = await storage.beginTransaction();
        if (work.err) {
            this.m_logger.error(`eventexecutor, beginTransaction error,storagefile=${storage.filePath}`);
            return {err: work.err};
        }
        let receipt = new Receipt();
        let returnCode;
        try {
            returnCode = await this.m_listener(context);
        } catch (e) {
            this.m_logger.error(`execute event linstener error, e=`, e);
            returnCode = ErrorCode.RESULT_EXCEPTION;
        }
        assert(isNumber(returnCode), `event handler return code invalid ${returnCode}`);
        if (!isNumber(returnCode)) {
            this.m_logger.error(`execute event failed for invalid return code`);
            returnCode = ErrorCode.RESULT_INVALID_PARAM;
        }
        receipt.returnCode = returnCode;
        if (receipt.returnCode === ErrorCode.RESULT_OK) {
            this.m_logger.debug(`event handler commit storage`);
            let err = await work.value!.commit();
            if (err) {
                this.m_logger.error(`eventexecutor, transaction commit error,storagefile=${storage.filePath}`);
                return {err};
            }
        } else {
            this.m_logger.debug(`event handler return code ${returnCode} rollback storage`);
            await work.value!.rollback();
        }
       
        return {err: ErrorCode.RESULT_OK, receipt};
    }
}
