import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger';
import db from '../models/database';

interface QAnythingConfig {
  enabled: boolean;
  apiBase: string;
  apiKey: string;
  kbId: string;
  mode: 'local' | 'cloud';
  topK: number;
}

class QAnythingService {
  private config: QAnythingConfig | null = null;

  /**
   * 加载配置
   */
  private loadConfig(): QAnythingConfig | null {
    try {
      const setting = db.prepare(
        "SELECT value FROM settings WHERE key = 'qanything_config'"
      ).get() as { value: string } | undefined;

      if (!setting) return null;

      return JSON.parse(setting.value) as QAnythingConfig;
    } catch (error) {
      logger.error('Failed to load QAnything config:', error);
      return null;
    }
  }

  /**
   * 获取配置（带缓存）
   */
  private getConfig(): QAnythingConfig | null {
    if (!this.config) {
      this.config = this.loadConfig();
    }
    return this.config;
  }

  /**
   * 清除缓存配置
   */
  clearConfigCache(): void {
    this.config = null;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    const config = this.getConfig();
    return config?.enabled || false;
  }

  /**
   * 获取配置的 topK 值
   */
  getTopK(): number {
    const config = this.getConfig();
    return config?.topK || 5;
  }

  /**
   * 查询知识库
   * @param question 用户问题
   * @param topK 返回的最多相关片段数
   * @returns 检索到的相关知识内容
   */
  async queryKnowledge(question: string, topK?: number): Promise<string> {
    const config = this.getConfig();
    if (!config || !config.enabled) {
      throw new Error('QAnything is not enabled');
    }

    const k = topK || config.topK || 5;

    try {
      logger.info(`🔍 Querying QAnything knowledge base: ${question.substring(0, 100)}`);

      const response = await axios.post(
        `${config.apiBase}/api/local_doc_qa/local_doc_chat`,
        {
          user_id: 'itops_agent',
          kb_ids: [config.kbId],
          question,
          top_k: k
        },
        {
          headers: {
            'Authorization': config.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data.code !== 200) {
        throw new Error(`QAnything API error: ${response.data.msg || response.data.message || 'Unknown error'}`);
      }

      // 提取检索结果
      const data = response.data.data;
      let context = '';

      if (data && data.response) {
        // 处理字符串响应
        if (typeof data.response === 'string') {
          context = data.response;
        }
        // 处理数组响应（chunks）
        else if (Array.isArray(data.response)) {
          const chunks = data.response.map((chunk: any) =>
            typeof chunk === 'string' ? chunk : (chunk.content || chunk.text || '')
          ).filter(Boolean);
          context = chunks.join('\n\n');
        }
        // 处理对象响应
        else if (typeof data.response === 'object') {
          context = data.response.content || data.response.text || JSON.stringify(data.response);
        }
      }

      if (!context) {
        logger.info('📭 No relevant knowledge found in QAnything');
        return '';
      }

      logger.info(`📚 Found relevant knowledge from QAnything (length: ${context.length})`);
      return context;

    } catch (error: any) {
      logger.error('❌ QAnything query failed:', error.message);
      throw error;
    }
  }

  /**
   * 上传文档到知识库
   * @param file 文件 Buffer
   * @param fileName 文件名
   * @returns 上传结果
   */
  async uploadDocument(file: Buffer, fileName: string): Promise<{ fileId: string; status: string }> {
    const config = this.getConfig();
    if (!config || !config.enabled) {
      throw new Error('QAnything is not enabled');
    }

    try {
      logger.info(`📤 Uploading document to QAnything: ${fileName}`);

      const formData = new FormData();
      formData.append('file', file, {
        filename: fileName,
        contentType: this.getContentType(fileName)
      });
      formData.append('kbId', config.kbId);
      formData.append('user_id', 'itops_agent');

      const response = await axios.post(
        `${config.apiBase}/api/local_doc_qa/upload_files`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': config.apiKey
          },
          timeout: 120000 // 上传大文件需要更长时间
        }
      );

      if (response.data.code !== 200) {
        throw new Error(`Upload failed: ${response.data.msg || response.data.message || 'Unknown error'}`);
      }

      const result = response.data.data?.[0] || response.data.data;
      logger.info(`✅ Document uploaded successfully: ${result?.fileId || result?.id || 'unknown'}`);

      return {
        fileId: result?.fileId || result?.id || '',
        status: result?.status || 'processing'
      };

    } catch (error: any) {
      logger.error('❌ Document upload failed:', error.message);
      throw error;
    }
  }

  /**
   * 查询文档解析状态
   * @param fileId 文件 ID
   */
  async getDocumentStatus(fileId: string): Promise<{ status: string; fileName: string }> {
    const config = this.getConfig();
    if (!config || !config.enabled) {
      throw new Error('QAnything is not enabled');
    }

    try {
      const response = await axios.get(
        `${config.apiBase}/api/local_doc_qa/get_file_status`,
        {
          params: {
            kb_id: config.kbId,
            file_id: fileId,
            user_id: 'itops_agent'
          },
          headers: {
            'Authorization': config.apiKey
          }
        }
      );

      const result = response.data.data?.[0] || response.data.data;
      return {
        status: result?.status || 'unknown',
        fileName: result?.file_name || result?.fileName || ''
      };

    } catch (error: any) {
      logger.error('❌ Failed to get document status:', error.message);
      throw error;
    }
  }

  /**
   * 删除文档
   * @param fileId 文件 ID
   */
  async deleteDocument(fileId: string): Promise<void> {
    const config = this.getConfig();
    if (!config || !config.enabled) {
      throw new Error('QAnything is not enabled');
    }

    try {
      await axios.post(
        `${config.apiBase}/api/local_doc_qa/delete_files`,
        {
          kb_id: config.kbId,
          file_ids: [fileId],
          user_id: 'itops_agent'
        },
        {
          headers: {
            'Authorization': config.apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info(`🗑️ Document deleted: ${fileId}`);

    } catch (error: any) {
      logger.error('❌ Failed to delete document:', error.message);
      throw error;
    }
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const config = this.getConfig();
    if (!config || !config.enabled) {
      return { success: false, message: 'QAnything is not enabled' };
    }

    try {
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers['Authorization'] = config.apiKey;
      }

      const response = await axios.get(
        `${config.apiBase}/api/health`,
        {
          headers,
          timeout: 10000
        }
      );

      if (response.status === 200) {
        return { success: true, message: 'Connection successful' };
      }

      return { success: false, message: `Unexpected response: ${response.status}` };
    } catch (error: any) {
      return {
        success: false,
        message: `Connection failed: ${error.message || 'Unknown error'}`
      };
    }
  }

  /**
   * 根据文件名获取 Content-Type
   */
  private getContentType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'md': 'text/markdown',
      'txt': 'text/plain',
      'csv': 'text/csv',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png'
    };
    return types[ext || ''] || 'application/octet-stream';
  }
}

export const qanythingService = new QAnythingService();
export default qanythingService;
